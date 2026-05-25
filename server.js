'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room registry (roomName -> Set<socketId>)
const rooms = new Map();
const MAX_PEERS = 2;

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  socket.on('join', ({ room }, cb) => {
    if (!room || typeof room !== 'string') {
      return cb?.({ ok: false, error: 'Invalid room name' });
    }

    const peers = rooms.get(room) || new Set();

    if (peers.size >= MAX_PEERS) {
      return cb?.({ ok: false, error: 'Room is full (max 2 participants)' });
    }

    socket.join(room);
    peers.add(socket.id);
    rooms.set(room, peers);
    socket.data.room = room;

    const otherPeers = [...peers].filter((id) => id !== socket.id);
    cb?.({ ok: true, isInitiator: otherPeers.length > 0, peers: otherPeers });

    // Notify the existing peer that someone joined
    socket.to(room).emit('peer-joined', { peerId: socket.id });
    console.log(`[room:${room}] ${socket.id} joined (${peers.size}/${MAX_PEERS})`);
  });

  // Generic signaling relay (offer, answer, ICE candidates)
  socket.on('signal', ({ to, data }) => {
    if (!to) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // UI state events (mute/camera/screen share status) — pure UX sync
  socket.on('peer-state', ({ to, state }) => {
    if (!to) return;
    io.to(to).emit('peer-state', { from: socket.id, state });
  });

  socket.on('leave', () => leaveRoom(socket));
  socket.on('disconnect', () => {
    leaveRoom(socket);
    console.log(`[-] ${socket.id} disconnected`);
  });
});

function leaveRoom(socket) {
  const room = socket.data.room;
  if (!room) return;
  const peers = rooms.get(room);
  if (peers) {
    peers.delete(socket.id);
    if (peers.size === 0) rooms.delete(room);
  }
  socket.to(room).emit('peer-left', { peerId: socket.id });
  socket.leave(room);
  socket.data.room = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}`));
