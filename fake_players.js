// Test helper: fills the local server with a few fake players so the server list shows
// full and half-full lobbies. `node fake_players.js [ws://127.0.0.1:8080]`, Ctrl+C to stop.
const WebSocket = require("ws");
const url = process.argv[2] || "ws://127.0.0.1:8080";
const fakes = [["Zoomer", 1], ["AerialAndy", 1], ["Flipz", 2]];   // [name, room]
for (const [name, room] of fakes) {
  const ws = new WebSocket(url);
  ws.on("open", () => {
    ws.send(JSON.stringify({ t: "hello", name }));
    setTimeout(() => ws.send(JSON.stringify({ t: "join", room, loadout: {} })), 300);
  });
}
