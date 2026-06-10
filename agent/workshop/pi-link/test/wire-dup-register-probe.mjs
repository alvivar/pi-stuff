// One-off live probe for finding #4: hub must ignore a duplicate `register`
// on an already-registered socket (no second welcome, no rename, no ghost entry).
// Not part of the test suite — run manually against a live hub.
import { createRequire } from "node:module";
const require = createRequire("C:/Users/andre/.pi/agent/npm/node_modules/");
const WebSocket = require("ws");

const log = (...a) => console.log(...a);
const ws = new WebSocket("ws://127.0.0.1:9900");
let welcomes = 0;
let assignedName = "";
const received = [];

ws.on("open", () => {
  log("connected; sending register #1 (wiretest-A)");
  ws.send(JSON.stringify({ type: "register", name: "wiretest-A", cwd: "C:/probe" }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  received.push(msg.type + (msg.name ? `(${msg.name})` : ""));
  if (msg.type === "welcome") {
    welcomes++;
    if (welcomes === 1) {
      assignedName = msg.name;
      log(`welcome #1: assigned "${msg.name}"; sending duplicate register #2 (wiretest-B) on same socket`);
      ws.send(JSON.stringify({ type: "register", name: "wiretest-B", cwd: "C:/probe2" }));
      setTimeout(() => {
        log("--- verdict ---");
        log("messages received:", received.join(", "));
        if (welcomes === 1) {
          log(`PASS: duplicate register IGNORED (1 welcome, still "${assignedName}")`);
        } else {
          log("FAIL: duplicate register processed (second welcome received)");
        }
        ws.close();
        setTimeout(() => process.exit(welcomes === 1 ? 0 : 1), 300);
      }, 2500);
    } else {
      log(`welcome #${welcomes}: "${msg.name}" — duplicate register was PROCESSED`);
    }
  }
});

ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(2); });
