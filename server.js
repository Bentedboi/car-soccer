// Rocket Leauge online server: server list, 1v1 lobbies, map votes, and a relay for
// match data. It runs no physics: the first player in a lobby (the host, blue) simulates
// the match, the other player (orange) sends inputs and receives snapshots, both through
// here. Text frames are JSON lobby messages; binary frames are match data, forwarded
// untouched to the other player in the same lobby.
//
// Runs on Render (see render.yaml) or locally: `npm install`, then `node server.js`
// (port 8080, or $PORT).

const http = require("http");
const { WebSocketServer } = require("ws");

const PROTOCOL = 1;
const ROOM_COUNT = 8;
const MAX_PLAYERS = 2;
const MAP_COUNT = 4;          // main.STADIUMS
const CONDITIONS = 3;         // day / rain / night

const rooms = [];
for (let i = 0; i < ROOM_COUNT; i++) {
  rooms.push({ id: i, name: `SERVER ${i + 1}`, players: [], state: "waiting", votes: [-1, -1] });
}
const clients = new Set();

const server = http.createServer((req, res) => {
  // Plain HTTP: health check / wake-up ping.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, online: clients.size }));
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function roomInfo(r) {
  return {
    id: r.id, name: r.name, state: r.state, max: MAX_PLAYERS,
    players: r.players.map((p) => p.name),
    votes: r.votes,
  };
}

function broadcastList() {
  const msg = { t: "list", rooms: rooms.map(roomInfo) };
  for (const c of clients) if (c.named) send(c, msg);
}

function cleanName(s) {
  s = String(s || "").replace(/[^\w \-.]/g, "").trim().slice(0, 16);
  return s || "Player";
}

function cleanLoadout(l) {
  l = l || {};
  const int = (v) => (Number.isInteger(v) && v >= 0 && v < 64 ? v : 0);
  return { boost: int(l.boost), paint: int(l.paint), topper: int(l.topper) };
}

function leave(ws) {
  const r = ws.room;
  if (!r) return;
  ws.room = null;
  r.players = r.players.filter((p) => p !== ws);
  const wasPlaying = r.state === "playing";
  r.state = "waiting";
  r.votes = [-1, -1];
  for (const p of r.players) {
    if (wasPlaying) send(p, { t: "opponent_left" });
    send(p, { t: "room", room: roomInfo(r), you: 0 });
  }
  broadcastList();
}

function join(ws, id, loadout) {
  const r = rooms[id];
  if (!r) return send(ws, { t: "error", msg: "No such server." });
  if (ws.room === r) return;
  if (r.players.length >= MAX_PLAYERS) return send(ws, { t: "error", msg: `${r.name} is full.` });
  leave(ws);
  ws.loadout = cleanLoadout(loadout);
  r.players.push(ws);
  ws.room = r;
  if (r.players.length === MAX_PLAYERS) {
    r.state = "voting";
    r.votes = [-1, -1];
  }
  sendRoom(r);
  broadcastList();
}

function sendRoom(r) {
  r.players.forEach((p, i) => send(p, { t: "room", room: roomInfo(r), you: i }));
}

function vote(ws, map) {
  const r = ws.room;
  if (!r || r.state !== "voting" || !Number.isInteger(map) || map < 0 || map >= MAP_COUNT) return;
  const i = r.players.indexOf(ws);
  r.votes[i] = map;
  sendRoom(r);
  broadcastList();
  if (r.votes.every((v) => v >= 0)) {
    // The randomizer: one of the two voted maps.
    const pick = r.votes[Math.floor(Math.random() * 2)];
    const condition = Math.floor(Math.random() * CONDITIONS);
    r.state = "playing";
    const players = r.players.map((p) => ({ name: p.name, loadout: p.loadout }));
    r.players.forEach((p, idx) =>
      send(p, { t: "start", map: pick, votes: r.votes, condition, players, you: idx }));
    broadcastList();
  }
}

wss.on("connection", (ws) => {
  ws.alive = true;
  ws.named = false;
  ws.room = null;
  clients.add(ws);
  ws.on("pong", () => (ws.alive = true));

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Match data: forward to the other player in the lobby.
      const r = ws.room;
      if (!r || r.state !== "playing") return;
      for (const p of r.players) if (p !== ws && p.readyState === p.OPEN) p.send(data, { binary: true });
      return;
    }
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    switch (m.t) {
      case "hello":
        ws.name = cleanName(m.name);
        ws.named = true;
        send(ws, { t: "welcome", protocol: PROTOCOL, name: ws.name });
        send(ws, { t: "list", rooms: rooms.map(roomInfo) });
        if (ws.room) broadcastList();   // a rename shows up in the list
        break;
      case "join":
        if (ws.named) join(ws, m.room, m.loadout);
        break;
      case "leave":
        leave(ws);
        break;
      case "vote":
        vote(ws, m.map);
        break;
      case "match_over":
        // From the host when the final whistle goes: back to voting for a rematch.
        if (ws.room && ws.room.state === "playing" && ws.room.players[0] === ws) {
          ws.room.state = "voting";
          ws.room.votes = [-1, -1];
          sendRoom(ws.room);
          broadcastList();
        }
        break;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    leave(ws);
  });
});

// Drop connections that stopped answering pings (closed laptop lids etc.).
setInterval(() => {
  for (const ws of clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 20000);

const port = process.env.PORT || 8080;
server.listen(port, () => console.log(`Rocket Leauge server on port ${port}`));
