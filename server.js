'use strict';

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_PEERS = parseInt(process.env.MAX_PEERS_PER_ROOM || '2', 10);
const ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS || '[]');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  pingTimeout: 20000,
});

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
      },
    },
  })
);
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: NODE_ENV === 'production' ? '1d' : 0 }));

// Expose only safe runtime config to client
app.get('/config', (_req, res) => {
  res.json({ iceServers: ICE_SERVERS, maxPeers: MAX_PEERS });
});

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Pretty room URL
app.get('/room/:name', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// ─── Signaling ───────────────────────────────────────────────────────────
const rooms = new Map(); // roomName -> Set<socketId>

const sanitizeRoom = (name) =>
  String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 40);

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join', ({ room, displayName }, ack) => {
    const roomName = sanitizeRoom(room);
    if (!roomName) return ack?.({ ok: false, error: 'Invalid room name' });

    const peers = rooms.get(roomName) || new Set();
    if (peers.size >= MAX_PEERS) return ack?.({ ok: false, error: 'Room is full' });

    socket.join(roomName);
    peers.add(socket.id);
    rooms.set(roomName, peers);
    joinedRoom = roomName;
    socket.data.displayName = String(displayName || 'Guest').slice(0, 30);

    const otherPeers = [...peers].filter((id) => id !== socket.id);
    ack?.({ ok: true, peers: otherPeers, selfId: socket.id });

    socket.to(roomName).emit('peer-joined', {
      id: socket.id,
      displayName: socket.data.displayName,
    });
  });

  // Relay WebRTC signaling messages
  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('peer-state', ({ to, state }) => {
    if (to) io.to(to).emit('peer-state', { from: socket.id, state });
    else if (joinedRoom) socket.to(joinedRoom).emit('peer-state', { from: socket.id, state });
  });

  const leave = () => {
    if (!joinedRoom) return;
    const peers = rooms.get(joinedRoom);
    if (peers) {
      peers.delete(socket.id);
      if (peers.size === 0) rooms.delete(joinedRoom);
    }
    socket.to(joinedRoom).emit('peer-left', { id: socket.id });
    joinedRoom = null;
  };

  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`\n[${signal}] Shutting down...`);
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, () => {
  console.log(`🚀 webRTC-meet running on http://localhost:${PORT}  [${NODE_ENV}]`);
});