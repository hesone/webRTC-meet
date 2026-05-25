'use strict';

// ─── Setup ───────────────────────────────────────────────────────────────
const roomName = decodeURIComponent(location.pathname.split('/').pop() || '');
const params = new URLSearchParams(location.search);
const displayName = (params.get('name') || localStorage.getItem('webRTC-meet:name') || 'Guest').slice(0, 30);

const $ = (id) => document.getElementById(id);
const els = {
  localVideo: $('localVideo'),
  remoteVideo: $('remoteVideo'),
  remoteTile: $('remoteTile'),
  localTile: $('localTile'),
  status: $('status'),
  roomLabel: $('roomLabel'),
  localName: $('localName'),
  remoteName: $('remoteName'),
  localBadges: $('localBadges'),
  remoteBadges: $('remoteBadges'),
  btnMic: $('btnMic'),
  btnCam: $('btnCam'),
  btnShare: $('btnShare'),
  btnLeave: $('btnLeave'),
  copyLink: $('copyLink'),
};

els.roomLabel.textContent = `/ ${roomName}`;
els.localName.textContent = `${displayName} (you)`;

const setStatus = (text, cls = '') => {
  els.status.textContent = text;
  els.status.className = `status ${cls}`;
};

const toast = (msg, ms = 2200) => {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
};

// ─── Globals ─────────────────────────────────────────────────────────────
let pc = null;
let localStream = null;
let cameraTrack = null;        // original camera video track (kept while screen sharing)
let screenStream = null;
let videoSender = null;
let polite = false;            // perfect negotiation role
let makingOffer = false;
let ignoreOffer = false;
let remotePeerId = null;
let socket = null;

const state = {
  micOn: true,
  camOn: true,
  sharing: false,
};

// ─── Boot ────────────────────────────────────────────────────────────────
(async function start() {
  try {
    const cfg = await fetch('/config').then((r) => r.json());

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    els.localVideo.srcObject = localStream;
    cameraTrack = localStream.getVideoTracks()[0];

    socket = io({ transports: ['websocket', 'polling'] });
    bindSocket(cfg.iceServers);
    bindUI();
  } catch (err) {
    console.error(err);
    setStatus('Camera/Microphone access denied', 'error');
    toast('Please allow camera and microphone, then reload.');
  }
})();

// ─── Socket / Signaling ──────────────────────────────────────────────────
function bindSocket(iceServers) {
  socket.on('connect', () => {
    socket.emit('join', { room: roomName, displayName }, (res) => {
      if (!res?.ok) {
        setStatus(res?.error || 'Could not join room', 'error');
        toast(res?.error || 'Could not join room');
        setTimeout(() => (location.href = '/'), 2500);
        return;
      }
      // Existing peer present → we are the polite peer & we make the offer
      polite = res.peers.length > 0;
      if (res.peers.length > 0) {
        remotePeerId = res.peers[0];
        createPeer(iceServers, /* initiator */ true);
      } else {
        setStatus('Waiting for someone to join…');
      }
    });
  });

  socket.on('peer-joined', ({ id, displayName: rn }) => {
    if (remotePeerId) return; // already paired
    remotePeerId = id;
    els.remoteName.textContent = rn || 'Guest';
    createPeer(iceServers, /* initiator */ false);
    toast(`${rn || 'Someone'} joined`);
  });

  socket.on('signal', async ({ from, data }) => {
    if (!pc || from !== remotePeerId) return;
    try {
      if (data.description) {
        const offerCollision = data.description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          socket.emit('signal', { to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); }
        catch (e) { if (!ignoreOffer) throw e; }
      }
    } catch (err) {
      console.error('Signal error', err);
    }
  });

  socket.on('peer-state', ({ from, state: s }) => {
    if (from !== remotePeerId) return;
    renderRemoteBadges(s);
  });

  socket.on('peer-left', ({ id }) => {
    if (id !== remotePeerId) return;
    toast('Peer left the call');
    teardownPeer();
    setStatus('Waiting for someone to join…');
  });

  socket.on('disconnect', () => setStatus('Disconnected', 'error'));
}

// ─── Peer Connection ─────────────────────────────────────────────────────
function createPeer(iceServers, initiator) {
  pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

  for (const track of localStream.getTracks()) {
    const sender = pc.addTrack(track, localStream);
    if (track.kind === 'video') videoSender = sender;
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && remotePeerId) {
      socket.emit('signal', { to: remotePeerId, data: { candidate } });
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('signal', { to: remotePeerId, data: { description: pc.localDescription } });
    } catch (err) {
      console.error('Negotiation error', err);
    } finally {
      makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    switch (pc.connectionState) {
      case 'connected':   setStatus('Connected', 'connected'); break;
      case 'connecting':  setStatus('Connecting…'); break;
      case 'disconnected':setStatus('Reconnecting…'); break;
      case 'failed':      setStatus('Connection failed', 'error'); pc.restartIce?.(); break;
      case 'closed':      setStatus('Call ended'); break;
    }
  };

  pc.ontrack = ({ streams: [stream] }) => {
    els.remoteVideo.srcObject = stream;
    els.remoteTile.classList.remove('placeholder');
  };

  // Send initial state once paired
  sendLocalState();
}

function teardownPeer() {
  try { pc?.getSenders().forEach((s) => s.track && s.track.kind && null); } catch {}
  try { pc?.close(); } catch {}
  pc = null;
  videoSender = null;
  remotePeerId = null;
  els.remoteVideo.srcObject = null;
  els.remoteTile.classList.add('placeholder');
  els.remoteBadges.textContent = '';
}

// ─── UI Bindings ─────────────────────────────────────────────────────────
function bindUI() {
  els.btnMic.addEventListener('click', toggleMic);
  els.btnCam.addEventListener('click', toggleCam);
  els.btnShare.addEventListener('click', toggleShare);
  els.btnLeave.addEventListener('click', leave);
  els.copyLink.addEventListener('click', copyInvite);

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea')) return;
    if (e.key === 'm' || e.key === 'M') toggleMic();
    else if (e.key === 'v' || e.key === 'V') toggleCam();
    else if (e.key === 's' || e.key === 'S') toggleShare();
    else if (e.key === 'Escape') leave();
  });

  window.addEventListener('beforeunload', () => socket?.emit('leave'));
  renderLocalBadges();
}

function toggleMic() {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  state.micOn = !state.micOn;
  track.enabled = state.micOn;
  els.btnMic.setAttribute('aria-pressed', String(!state.micOn));
  els.btnMic.querySelector('.ico').textContent = state.micOn ? '🎤' : '🔇';
  renderLocalBadges();
  sendLocalState();
}

function toggleCam() {
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  state.camOn = !state.camOn;
  track.enabled = state.camOn;
  els.btnCam.setAttribute('aria-pressed', String(!state.camOn));
  els.btnCam.querySelector('.ico').textContent = state.camOn ? '📹' : '📷';
  renderLocalBadges();
  sendLocalState();
}

async function toggleShare() {
  if (!pc) return toast('Not connected yet');
  try {
    if (!state.sharing) {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = screenStream.getVideoTracks()[0];
      await videoSender.replaceTrack(screenTrack);
      els.localVideo.srcObject = new MediaStream([screenTrack, ...localStream.getAudioTracks()]);
      els.localTile.classList.add('sharing');
      state.sharing = true;
      els.btnShare.classList.add('active');
      screenTrack.onended = () => stopShare();
    } else {
      stopShare();
    }
    renderLocalBadges();
    sendLocalState();
  } catch (err) {
    console.warn('Screen share cancelled', err);
  }
}

async function stopShare() {
  if (!state.sharing) return;
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  if (cameraTrack && videoSender) await videoSender.replaceTrack(cameraTrack);
  els.localVideo.srcObject = localStream;
  els.localTile.classList.remove('sharing');
  state.sharing = false;
  els.btnShare.classList.remove('active');
  renderLocalBadges();
  sendLocalState();
}

function leave() {
  try { socket?.emit('leave'); } catch {}
  teardownPeer();
  localStream?.getTracks().forEach((t) => t.stop());
  location.href = '/';
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(location.origin + `/room/${encodeURIComponent(roomName)}`);
    toast('Invite link copied');
  } catch {
    toast('Could not copy link');
  }
}

// ─── Presence indicators ─────────────────────────────────────────────────
function renderLocalBadges() {
  const parts = [];
  if (!state.micOn) parts.push('🔇');
  if (!state.camOn) parts.push('📷');
  if (state.sharing) parts.push('🖥️');
  els.localBadges.textContent = parts.join(' ');
}

function renderRemoteBadges(s) {
  const parts = [];
  if (!s.micOn) parts.push('🔇');
  if (!s.camOn) parts.push('📷');
  if (s.sharing) parts.push('🖥️');
  els.remoteBadges.textContent = parts.join(' ');
}

function sendLocalState() {
  if (!remotePeerId) return;
  socket.emit('peer-state', {
    to: remotePeerId,
    state: { micOn: state.micOn, camOn: state.camOn, sharing: state.sharing },
  });
}