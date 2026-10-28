// Rocket Leauge online server: server list, 1v1 lobbies, map votes, and the match servers.
// Every match runs on a headless copy of the game (Godot) that this process starts when
// the map vote finishes, so neither player is the host: both send their inputs here and
// get snapshots back, and both predict their own car. Text frames are JSON lobby messages;
// binary frames are match data. From a player they go to the match server with the player's
// index (0 blue, 1 orange) put in front; from the match server they go to both players.
//
// Runs in Docker (see Dockerfile / render.yaml) or locally: `npm install`, then
//   GODOT_BIN=path/to/Godot.exe GAME_PATH=path/to/rocket-leauge node server.js
// (port 8080, or $PORT).
//
// Where the game comes from:
//   GAME_PATH  a project folder (godot --path), used as is: local testing.
//   otherwise  the newest release of REPO (game.pck from GitHub Releases) is downloaded
//              into GAME_DIR and refreshed whenever a new version is published, so the
//              match servers always run the same game as the players' auto-updater serves.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const PROTOCOL = 2;
const ROOM_COUNT = 8;
const MAX_PLAYERS = 2;
const MAP_COUNT = 4;          // main.STADIUMS
const CONDITIONS = 3;         // day / rain / night
const SIM_CONNECT_MS = 30000; // how long a match server may take to connect

const PORT = process.env.PORT || 8080;
const GODOT_BIN = process.env.GODOT_BIN || "godot";
const GAME_PATH = process.env.GAME_PATH || "";
const REPO = process.env.REPO || "Bentedboi/car-soccer";
const GAME_DIR = process.env.GAME_DIR || path.join(__dirname, "game");
const MAX_SIMS = parseInt(process.env.MAX_SIMS || "4", 10);

const rooms = [];
for (let i = 0; i < ROOM_COUNT; i++) {
  rooms.push({
    id: i, name: `SERVER ${i + 1}`, players: [], state: "waiting", votes: [-1, -1],
    sim: null, proc: null, secret: null, pending: null, timer: null,
  });
}
const clients = new Set();
let simCount = 0;

const server = http.createServer((req, res) => {
  // Plain HTTP: health check / wake-up ping.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, online: clients.size, matches: simCount }));
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

// ------------------------------------------------------------------ the game files

let gameVersion = 0;
let gameCheckedAt = 0;
let gameChecking = null;

function gameArgs() {
  if (GAME_PATH) return ["--path", GAME_PATH];
  return ["--main-pack", path.join(GAME_DIR, "game.pck")];
}

// Make sure the newest published game is on disk (at most one check a minute).
function ensureGame() {
  if (GAME_PATH) return Promise.resolve(true);
  if (gameChecking) return gameChecking;
  if (gameVersion && Date.now() - gameCheckedAt < 60000) return Promise.resolve(true);
  gameChecking = (async () => {
    try {
      fs.mkdirSync(GAME_DIR, { recursive: true });
      const base = `https://github.com/${REPO}/releases/latest/download/`;
      const info = await (await fetch(base + "version.json")).json();
      const pck = path.join(GAME_DIR, "game.pck");
      if (!gameVersion && fs.existsSync(pck) && fs.existsSync(path.join(GAME_DIR, "version.json"))) {
        gameVersion = JSON.parse(fs.readFileSync(path.join(GAME_DIR, "version.json"), "utf8")).version || 0;
      }
      if (info.version > gameVersion || !fs.existsSync(pck)) {
        console.log(`Downloading game v${info.version}...`);
        const res = await fetch(base + (info.pck || "game.pck"));
        if (!res.ok) throw new Error("HTTP " + res.status);
        const bytes = Buffer.from(await res.arrayBuffer());
        const sum = crypto.createHash("sha256").update(bytes).digest("hex");
        if (info.sha256 && sum !== info.sha256) throw new Error("checksum mismatch");
        fs.writeFileSync(pck + ".part", bytes);
        fs.renameSync(pck + ".part", pck);
        fs.writeFileSync(path.join(GAME_DIR, "version.json"), JSON.stringify(info));
        gameVersion = info.version;
      }
      gameCheckedAt = Date.now();
      return true;
    } catch (e) {
      console.log("Couldn't update the game files:", e.message);
      gameCheckedAt = Date.now();
      return fs.existsSync(path.join(GAME_DIR, "game.pck"));   // an older copy still works
    } finally {
      gameChecking = null;
    }
  })();
  return gameChecking;
}

// ------------------------------------------------------------------ match servers

function stopSim(r) {
  if (r.timer) clearTimeout(r.timer);
  r.timer = null;
  r.pending = null;
  const proc = r.proc;
  r.proc = null;
  r.sim = null;
  r.secret = null;
  if (proc) {
    proc.removeAllListeners("exit");
    proc.kill();
    simCount = Math.max(0, simCount - 1);
  }
}

// Back to the vote (the match is over, or could not run).
function backToVoting(r) {
  stopSim(r);
  r.state = r.players.length === MAX_PLAYERS ? "voting" : "waiting";
  r.votes = [-1, -1];
  sendRoom(r);
  broadcastList();
}

function abortMatch(r, why) {
  const wasPlaying = r.state === "playing";
  for (const p of r.players) {
    if (wasPlaying) send(p, { t: "opponent_left" });
    else send(p, { t: "error", msg: why });
  }
  backToVoting(r);
}

async function startMatch(r, pick, condition) {
  r.state = "starting";
  broadcastList();
  if (simCount >= MAX_SIMS) return abortMatch(r, "All the match servers are busy. Try again in a minute.");
  if (!(await ensureGame())) return abortMatch(r, "The game files aren't available on the server yet.");
  if (r.state !== "starting" || r.players.length !== MAX_PLAYERS) return;   // someone left meanwhile
  r.secret = crypto.randomBytes(12).toString("hex");
  r.pending = {
    map: pick, votes: r.votes.slice(), condition,
    players: r.players.map((p) => ({ name: p.name, loadout: p.loadout })),
  };
  const args = ["--headless", ...gameArgs(), "--",
    `--server=ws://127.0.0.1:${PORT}`, `--sim-room=${r.id}`, `--sim-secret=${r.secret}`];
  let proc;
  try {
    proc = spawn(GODOT_BIN, args, { stdio: ["ignore", "inherit", "inherit"] });
  } catch (e) {
    return abortMatch(r, "Couldn't start the match server.");
  }
  r.proc = proc;
  simCount++;
  proc.on("error", (e) => {
    console.log(`${r.name}: couldn't run ${GODOT_BIN}:`, e.message);
    if (r.proc === proc) { r.proc = null; simCount = Math.max(0, simCount - 1); abortMatch(r, "Couldn't start the match server."); }
  });
  proc.on("exit", (code) => {
    if (r.proc !== proc) return;
    console.log(`${r.name}: match server exited (${code})`);
    r.proc = null;
    simCount = Math.max(0, simCount - 1);
    if (r.state === "starting" || r.state === "playing") abortMatch(r, "The match server stopped.");
  });
  r.timer = setTimeout(() => {
    if (r.state === "starting") abortMatch(r, "The match server didn't start. Try again.");
  }, SIM_CONNECT_MS);
}

// A match server said hello: hand it its lobby's match and tell the players to begin.
function simHello(ws, m) {
  const r = rooms[m.room];
  if (!r || !r.pending || !r.secret || m.secret !== r.secret || m.v !== PROTOCOL) return ws.close();
  ws.isSim = true;
  ws.room = r;
  r.sim = ws;
  if (r.timer) clearTimeout(r.timer);
  r.timer = null;
  const p = r.pending;
  r.pending = null;
  r.secret = null;
  r.state = "playing";
  send(ws, { t: "sim_ok" });
  send(ws, { t: "sim_start", map: p.map, votes: p.votes, condition: p.condition, players: p.players, you: 0 });
  r.players.forEach((pl, idx) =>
    send(pl, { t: "start", map: p.map, votes: p.votes, condition: p.condition, players: p.players, you: idx }));
  broadcastList();
}

// ------------------------------------------------------------------ lobbies

function leave(ws) {
  const r = ws.room;
  if (!r || ws.isSim) return;
  ws.room = null;
  r.players = r.players.filter((p) => p !== ws);
  const wasPlaying = r.state === "playing";
  stopSim(r);
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
    startMatch(r, pick, condition);
  }
}

wss.on("connection", (ws) => {
  ws.alive = true;
  ws.named = false;
  ws.isSim = false;
  ws.room = null;
  clients.add(ws);
  ws.on("pong", () => (ws.alive = true));

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const r = ws.room;
      if (!r || r.state !== "playing") return;
      if (ws.isSim) {
        // Match server -> both players.
        for (const p of r.players) if (p.readyState === p.OPEN) p.send(data, { binary: true });
      } else if (r.sim && r.sim.readyState === r.sim.OPEN) {
        // Player -> match server, tagged with who sent it.
        r.sim.send(Buffer.concat([Buffer.from([r.players.indexOf(ws)]), data]), { binary: true });
      }
      return;
    }
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === "sim") return simHello(ws, m);
    if (ws.isSim) {
      if (m.t === "match_over" && ws.room && ws.room.state === "playing") backToVoting(ws.room);
      return;
    }
    switch (m.t) {
      case "hello":
        if (m.v !== PROTOCOL) {
          send(ws, { t: "error", msg: "This server needs a newer version of the game. Restart the game to update." });
          return ws.close();
        }
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
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    if (ws.isSim) {
      const r = ws.room;
      if (r && r.sim === ws) {
        r.sim = null;
        if (r.state === "playing") abortMatch(r, "The match server stopped.");
      }
      return;
    }
    leave(ws);
  });
});

// Drop connections that stopped answering pings (closed laptop lids etc.).
setInterval(() => {
  for (const ws of clients) {
    if (ws.isSim) continue;
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 20000);

// Match servers die with this process.
function shutdown() {
  for (const r of rooms) stopSim(r);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, () => {
  console.log(`Rocket Leauge server on port ${PORT}`);
  ensureGame();   // fetch the game now so the first match doesn't wait for it
});
