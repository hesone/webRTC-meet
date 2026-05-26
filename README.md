# webRTC-meet

Production-ready peer-to-peer video meetings using WebRTC, Node.js and Socket.IO.

## Features
- 🪪 Create / join a room by name (max **2** people per room)
- 🛰️ P2P via Google STUN (configurable for TURN)
- 🎤 Mute / unmute, 📹 camera on/off, 🖥️ screen sharing
- ⌨️ Keyboard shortcuts: `M` mic · `V` camera · `S` share · `Esc` leave
- 🔐 Helmet + CSP, compression, graceful shutdown
- 🔁 Perfect-negotiation pattern (robust against glare/ICE restarts)
- 🌐 Env-driven configuration (no secrets in code)

## Quick start
```bash
git clone <repo> webRTC-meet
cd webRTC-meet
cp .env.example .env
npm install
npm start
```
Open `http://localhost:3000` in **two browser windows / devices** and join the same room.

> ⚠️ Browsers require **HTTPS** for `getUserMedia` on non-localhost. Deploy behind a TLS proxy (Caddy, Nginx, Cloudflare).

## Production deployment
- Run behind HTTPS reverse proxy. WebSocket upgrade headers must be forwarded.
- For users behind strict NATs, add a TURN server (e.g. `coturn`) to `ICE_SERVERS`.
- Use a process manager (`pm2`, `systemd`) and forward `SIGTERM`.

## Environment variables
| Name | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `production` enables asset caching |
| `MAX_PEERS_PER_ROOM` | `2` | Hard cap per room |
| `ICE_SERVERS` | Google STUN | JSON array of RTCIceServer objects |
| `CF_API_TOKEN` | Cloudflare API Token | Optional. Used to generate Cloudflare TURN credentials; falls back to default ICE servers if omitted |
| `CF_TURN_KEY_ID` | Cloudflare Key ID | Optional. Cloudflare TURN key identifier used with `CF_API_TOKEN` |

## License
MIT