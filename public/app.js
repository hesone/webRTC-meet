// app.js — WebRTC 1:1 client with clean state management
'use strict';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  lobby: $('lobby'),
  meeting: $('meeting'),
  joinForm: $('join-form'),
  roomInput: $('room-input'),
  joinBtn: $('join-btn'),
  lobbyError: $('lobby-error'),
  roomName: $('room-name'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  localVideo: $('local-video'),
  remoteVideo: $('remote-video'),
  remoteLabel: $('remote-label'),
  remotePlaceholder: $('remote-placeholder'),
  localMicBadge: $('local-mic-badge'),
  remoteMicBadge: $('remote-mic-badge'),
  btnMic: $('btn-mic'),
  btnCam: $('btn-cam'),
  btnShare: $('btn-share'),
  btnLeave: $('btn-leave'),
  toast: $('toast'),
};

// ---------- State ----------
const state = {
  socket: null,
  pc: null,
  localStream: null,
  cameraTrack: null,        // original camera track (preserved when sharing)
  screenStream: null,
  remotePeerId: null,
  isSharing: false,
  micOn: true,
  camOn: true,
};

// ---------- Utilities ----------
const setStatus = (text, stateName) => {
  els.statusText.textContent = text;
  els.statusDot.dataset.state = stateName;
};

const showToast = (msg, ms = 2500) => {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('show'), ms);
};

const showError = (msg) => {
  els.lobbyError.textContent = msg;
};

// ---------- Lobby ----------
els.joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const room = els.roomInput.value.trim();
  if (!room) return;

  els.joinBtn.disabled = true;
  els.joinBtn.textContent = 'Joining…';

  try {
    await initMedia();
    await connectSocket();
    const res = await joinRoom(room);
    if (!res.ok) throw new Error(res.error || 'Failed to join');

    els.roomName.textContent = room;
    els.lobby.classList.add('hidden');
    els.meeting.classList.remove('hidden');

    if (res.isInitiator) {
      state.remotePeerId = res.peers[0];
      await createPeerConnection();
      await makeOffer();
    } else {
      setStatus('Waiting for guest…', 'idle');
    }
  } catch (err) {
    console.error(err);
    showError(err.message);
    cleanupMedia();
    els.joinBtn.disabled = false;
    els.joinBtn.textContent = 'Join Room';
  }
});

// ---------- Media ----------
async function initMedia() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    state.cameraTrack = state.localStream.getVideoTracks()[0];
    els.localVideo.srcObject = state.localStream;
  } catch (err) {
    throw new Error('Camera/microphone permission denied');
  }
}

// ---------- Socket ----------
function connectSocket() {
  return new Promise((resolve, reject) => {
    state.socket = io({ transports: ['websocket'] });
    state.socket.once('connect', resolve);
    state.socket.once('connect_error', () =>
      reject(new Error('Cannot reach signaling server'))
    );
    bindSocketEvents();
  });
}

function joinRoom(room) {
  return new Promise((resolve) =>
    state.socket.emit('join', { room }, resolve)
  );
}

function bindSocketEvents() {
  const s = state.socket;

  s.on('peer-joined', async ({ peerId }) => {
    showToast('Guest joined');
    state.remotePeerId = peerId;
    // Other side (initiator) will send the offer — we just prepare PC
    if (!state.pc) await createPeerConnection();
  });

  s.on('signal', async ({ from, data }) => {
    state.remotePeerId = from;
    if (!state.pc) await createPeerConnection();

    try {
      if (data.type === 'offer') {
        await state.pc.setRemoteDescription(data);
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);
        sendSignal({ type: 'answer', sdp: answer.sdp });
      } else if (data.type === 'answer') {
        await state.pc.setRemoteDescription(data);
      } else if (data.candidate) {
        await state.pc.addIceCandidate(data.candidate).catch(() => {});
      }
    } catch (err) {
      console.error('Signal handling error:', err);
    }
  });

  s.on('peer-state', ({ state: peerState }) => {
    if (typeof peerState.micOn === 'boolean') {
      els.remoteMicBadge.classList.toggle('off', !peerState.micOn);
    }
  });

  s.on('peer-left', () => {
    showToast('Guest left the room');
    resetPeer();
    setStatus('Waiting for guest…', 'idle');
  });
}

function sendSignal(data) {
  if (!state.remotePeerId) return;
  state.socket.emit('signal', { to: state.remotePeerId, data });
}

function sendPeerState() {
  if (!state.remotePeerId) return;
  state.socket.emit('peer-state', {
    to: state.remotePeerId,
    state: { micOn: state.micOn, camOn: state.camOn },
  });
}

// ---------- WebRTC ----------
async function createPeerConnection() {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  state.pc = pc;

  // Add local tracks
  state.localStream.getTracks().forEach((track) =>
    pc.addTrack(track, state.localStream)
  );

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ candidate });
  };

  pc.ontrack = ({ streams }) => {
    if (els.remoteVideo.srcObject !== streams[0]) {
      els.remoteVideo.srcObject = streams[0];
      els.remotePlaceholder.classList.add('hidden');
      els.remoteLabel.textContent = 'Guest';
    }
  };

  pc.onconnectionstatechange = () => {
    const cs = pc.connectionState;
    if (cs === 'connected') setStatus('Connected', 'connected');
    else if (cs === 'connecting') setStatus('Connecting…', 'connecting');
    else if (cs === 'disconnected') setStatus('Reconnecting…', 'connecting');
    else if (cs === 'failed' || cs === 'closed') {
      setStatus('Disconnected', 'idle');
    }
  };
}

async function makeOffer() {
  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  sendSignal({ type: 'offer', sdp: offer.sdp });
}

function resetPeer() {
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  state.remotePeerId = null;
  els.remoteVideo.srcObject = null;
  els.remotePlaceholder.classList.remove('hidden');
  els.remoteLabel.textContent = 'Waiting for guest…';
  els.remoteMicBadge.classList.remove('off');
}

// ---------- Controls ----------
els.btnMic.addEventListener('click', () => {
  state.micOn = !state.micOn;
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
  els.btnMic.setAttribute('aria-pressed', state.micOn);
  els.btnMic.classList.toggle('off', !state.micOn);
  els.btnMic.querySelector('.ctrl-label').textContent = state.micOn ? 'Mute' : 'Unmute';
  els.localMicBadge.classList.toggle('off', !state.micOn);
  sendPeerState();
});

els.btnCam.addEventListener('click', () => {
  state.camOn = !state.camOn;
  if (state.cameraTrack) state.cameraTrack.enabled = state.camOn;
  els.btnCam.setAttribute('aria-pressed', state.camOn);
  els.btnCam.classList.toggle('off', !state.camOn);
  els.btnCam.querySelector('.ctrl-label').textContent = state.camOn ? 'Camera' : 'Start Cam';
  sendPeerState();
});

els.btnShare.addEventListener('click', toggleScreenShare);

async function toggleScreenShare() {
  if (state.isSharing) return stopScreenShare();

  try {
    const screen = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });
    const screenTrack = screen.getVideoTracks()[0];
    state.screenStream = screen;

    // Replace outgoing video track in the existing PC sender
    const sender = state.pc?.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(screenTrack);

    // Mirror locally
    els.localVideo.srcObject = new MediaStream([
      screenTrack,
      ...state.localStream.getAudioTracks(),
    ]);

    state.isSharing = true;
    els.btnShare.setAttribute('aria-pressed', 'true');
    els.btnShare.classList.add('active');
    els.btnShare.querySelector('.ctrl-label').textContent = 'Stop Share';
    showToast('Screen sharing started');

    // Auto-stop when user clicks browser's "stop sharing"
    screenTrack.addEventListener('ended', stopScreenShare);
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      console.error(err);
      showToast('Could not start sharing');
    }
  }
}

async function stopScreenShare() {
  if (!state.isSharing) return;

  state.screenStream?.getTracks().forEach((t) => t.stop());
  state.screenStream = null;

  // Restore camera track
  const sender = state.pc?.getSenders().find((s) => s.track?.kind === 'video');
  if (sender && state.cameraTrack) await sender.replaceTrack(state.cameraTrack);

  els.localVideo.srcObject = state.localStream;
  state.isSharing = false;
  els.btnShare.setAttribute('aria-pressed', 'false');
  els.btnShare.classList.remove('active');
  els.btnShare.querySelector('.ctrl-label').textContent = 'Share';
  showToast('Screen sharing stopped');
}

els.btnLeave.addEventListener('click', leaveMeeting);

function leaveMeeting() {
  state.socket?.emit('leave');
  cleanupMedia();
  resetPeer();
  state.socket?.disconnect();
  state.socket = null;

  els.meeting.classList.add('hidden');
  els.lobby.classList.remove('hidden');
  els.joinBtn.disabled = false;
  els.joinBtn.textContent = 'Join Room';
  els.roomInput.value = '';
}

function cleanupMedia() {
  state.localStream?.getTracks().forEach((t) => t.stop());
  state.screenStream?.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  state.screenStream = null;
  state.cameraTrack = null;
  els.localVideo.srcObject = null;
}

// ---------- Keyboard shortcuts (UX) ----------
window.addEventListener('keydown', (e) => {
  if (els.meeting.classList.contains('hidden')) return;
  if (e.target.tagName === 'INPUT') return;

  if (e.key === 'm' || e.key === 'M') els.btnMic.click();
  else if (e.key === 'v' || e.key === 'V') els.btnCam.click();
  else if (e.key === 's' || e.key === 'S') els.btnShare.click();
  else if (e.key === 'Escape') els.btnLeave.click();
});

// Cleanup on tab close
window.addEventListener('beforeunload', () => state.socket?.emit('leave'));
