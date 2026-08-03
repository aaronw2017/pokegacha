// Poké-Gacha Duel server — dumb WebSocket relay + static file server.
// NO battle logic here. It only:
//   - serves index.html (and any sibling files) over HTTP
//   - tracks who is online by username
//   - delivers challenge requests (online now, or queued until the target logs in)
//   - creates a 2-player "room" when a challenge is accepted
//   - relays each player's action and broadcasts the round once both are in
//   - forfeits a room when either side disconnects or leaves
// Both browsers run the identical deterministic battle resolution themselves,
// so the server never needs to compute damage.
//
// Run:  npm install && node server.js   (PORT env overrides default 3001)

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3001;
const ROOT = path.resolve(__dirname, ".."); // poke-gacha-battle/

// ------------------------------------------------------------------
//  In-memory state
// ------------------------------------------------------------------
const byUser = new Map();    // username slug -> ws
const clients = new Map();   // ws -> { user, name, room }
const challenges = new Map(); // challengeId -> { from, fromName, to }
const pending = new Map();   // username slug -> [challengeIds] (delivered on next login)
const rooms = new Map();     // roomId -> { id, a, b, round, over }

const randId = () => Math.random().toString(36).slice(2, 10);

// ------------------------------------------------------------------
//  HTTP: serve the game
// ------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  const target = url === "/" ? "/index.html" : url;
  const safe = path.normalize(target).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

// ------------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------------
const sendTo = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function broadcastOnline() {
  const online = [...clients.values()].map(c => c.name).filter(Boolean);
  [...byUser.values()].forEach(ws => sendTo(ws, { t: "status", online }));
}

function deliverChallenge(id) {
  const ch = challenges.get(id);
  if (!ch) return;
  const target = byUser.get(ch.to);
  if (target && target.readyState === 1) {
    sendTo(target, { t: "challenge", id, from: ch.fromName || ch.from });
    pending.delete(ch.to);
  } else {
    const arr = pending.get(ch.to);
    if (arr) arr.push(id);
    else pending.set(ch.to, [id]);
  }
}

function startRoom(ch) {
  const aWs = byUser.get(ch.from);
  const bWs = byUser.get(ch.to);
  if (!aWs || !bWs) return;
  const id = randId();
  const room = { id, a: { ws: aWs, action: null }, b: { ws: bWs, action: null }, round: 1, over: false };
  rooms.set(id, room);
  const ca = clients.get(aWs), cb = clients.get(bWs);
  if (ca) ca.room = id;
  if (cb) cb.room = id;
  sendTo(aWs, { t: "match", room: id, side: "a", opp: cb ? cb.name : ch.to });
  sendTo(bWs, { t: "match", room: id, side: "b", opp: ca ? ca.name : ch.from });
}

function endRoom(id, reason) {
  const room = rooms.get(id);
  if (!room || room.over) return;
  room.over = true;
  sendTo(room.a.ws, { t: "end", room: id, reason });
  sendTo(room.b.ws, { t: "end", room: id, reason });
  const ca = clients.get(room.a.ws), cb = clients.get(room.b.ws);
  if (ca) ca.room = null;
  if (cb) cb.room = null;
  rooms.delete(id);
}

// ------------------------------------------------------------------
//  WebSocket
// ------------------------------------------------------------------
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    let m;
    try { m = JSON.parse(data); } catch (_) { return; }
    const me = clients.get(ws);

    switch (m.t) {
      case "hello": {
        const u = (m.user || "").trim().toLowerCase().replace(/\s+/g, " ");
        if (!u) { sendTo(ws, { t: "error", msg: "No username." }); return; }
        if (byUser.has(u)) { sendTo(ws, { t: "error", msg: "That username is already connected." }); return; }
        if (me && byUser.get(me.user) === ws) byUser.delete(me.user);
        clients.set(ws, { user: u, name: m.name || u, room: null });
        byUser.set(u, ws);
        (pending.get(u) || []).forEach(id => {
          const ch = challenges.get(id);
          if (ch && ch.to === u) sendTo(ws, { t: "challenge", id, from: ch.fromName || ch.from });
        });
        pending.delete(u);
        broadcastOnline();
        break;
      }
      case "challenge": {
        if (!me) return;
        const to = (m.to || "").trim().toLowerCase().replace(/\s+/g, " ");
        if (!to || to === me.user) { sendTo(ws, { t: "challenge_sent", ok: false }); return; }
        if (me.room) { sendTo(ws, { t: "challenge_sent", ok: false }); return; } // busy in a duel
        const id = randId();
        challenges.set(id, { from: me.user, fromName: me.name, to });
        deliverChallenge(id);
        sendTo(ws, { t: "challenge_sent", to, ok: true });
        break;
      }
      case "challenge_resp": {
        if (!me) return;
        const ch = challenges.get(m.id);
        if (!ch || ch.to !== me.user) return;
        const ok = !!m.ok;
        const fromWs = byUser.get(ch.from);
        sendTo(fromWs, { t: "challenge_resp", from: me.name, ok });
        if (ok) startRoom(ch);
        challenges.delete(m.id);
        break;
      }
      case "team": {
        if (!me) return;
        const room = rooms.get(m.room);
        if (!room || room.over) return;
        const other = room.a.ws === ws ? room.b : (room.b.ws === ws ? room.a : null);
        if (!other) return;
        sendTo(other.ws, { t: "opp_team", room: room.id, team: m.team || [] });
        break;
      }
      case "action": {
        if (!me) return;
        const room = rooms.get(m.room);
        if (!room || room.over) return;
        const entry = room.a.ws === ws ? room.a : (room.b.ws === ws ? room.b : null);
        if (!entry) return;
        if (m.round !== room.round) return; // stale round — ignore
        entry.action = m.action;
        if (room.a.action && room.b.action) {
          const seed = Math.floor(Math.random() * 2147483647) + 1;
          const acts = [room.a.action, room.b.action];
          sendTo(room.a.ws, { t: "round", room: room.id, round: room.round, seed, acts });
          sendTo(room.b.ws, { t: "round", room: room.id, round: room.round, seed, acts });
          room.a.action = null;
          room.b.action = null;
          room.round++;
        }
        break;
      }
      case "leave": {
        const room = rooms.get(m.room);
        if (room) endRoom(room.id, "left");
        break;
      }
    }
  });

  ws.on("close", () => {
    const me = clients.get(ws);
    if (!me) return;
    if (byUser.get(me.user) === ws) byUser.delete(me.user);
    if (me.room) endRoom(me.room, "disconnected");
    clients.delete(ws);
    broadcastOnline();
  });

  ws.on("error", () => {});
});

server.listen(PORT, () => console.log(`⚔️  Poké-Gacha Duel server → http://localhost:${PORT}`));
