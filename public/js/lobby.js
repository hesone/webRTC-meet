const form = document.getElementById('joinForm');
const roomInput = document.getElementById('room');
const nameInput = document.getElementById('displayName');
const errorEl = document.getElementById('error');
const genBtn = document.getElementById('genRoom');

// Persist display name across sessions
nameInput.value = localStorage.getItem('webRTC-meet:name') || '';

const randomRoom = () => {
  const adj = ['swift','calm','bright','cosmic','vivid','quiet','bold','lucid'];
  const noun = ['otter','falcon','river','aurora','comet','willow','ember','orbit'];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return `${pick(adj)}-${pick(noun)}-${Math.floor(100 + Math.random() * 900)}`;
};

genBtn.addEventListener('click', () => {
  roomInput.value = randomRoom();
  roomInput.focus();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  errorEl.textContent = '';

  const name = nameInput.value.trim();
  const room = roomInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

  if (!name) return (errorEl.textContent = 'Please enter your name.');
  if (!room) return (errorEl.textContent = 'Please enter a valid room name.');

  localStorage.setItem('webRTC-meet:name', name);
  window.location.href = `/room/${encodeURIComponent(room)}?name=${encodeURIComponent(name)}`;
});
