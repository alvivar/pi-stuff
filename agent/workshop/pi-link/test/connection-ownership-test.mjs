#!/usr/bin/env node

// Behavior tests for connection-establishment ownership: single-flight
// initialization, cancellation of pending transports, stale-callback inertness,
// and the bounded opening handshake.
//
// The real extension is loaded and driven through its real handlers, commands and
// tools. Only the modules Pi supplies are stubbed, in-process: the `ws` stub is a
// dumb recorder that emits nothing on its own, so each test decides exactly when
// open/error/close/listening/connection arrive. No port is bound and no socket is
// dialled, so the live mesh is untouched.
//
// Usage: node test/connection-ownership-test.mjs
// Requires Node 22.18+ or 24+ (module.registerHooks and TypeScript type stripping).

import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const INDEX_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"),
).href;

// ── Stubs for the modules Pi provides ───────────────────────────────────────

// The hub hands this server to `ws` so it can answer `GET /status` on the link
// port. Registered under both specifier spellings so no suite can bind a real one.
// `listen` never emits on its own: each test decides when `listening`/`error`
// arrive, exactly like the `ws` stub below.
const HTTP_STUB = `
  import { EventEmitter } from "node:events";
  export const httpServers = [];
  class FakeHttpServer extends EventEmitter {
    constructor(handler) {
      super();
      this.handler = handler;
      this.listening = false;
      this.closed = false;
      this.listenArgs = null;
      // Counts every call, including the idempotent ones. A close site that runs
      // after the server is already closed is invisible in \`closed\` alone, so
      // without this a teardown test can pass while its own site does nothing.
      this.closeCalls = 0;
      httpServers.push(this);
    }
    listen(...args) { this.listenArgs = args; this.listening = true; return this; }
    close() {
      this.closeCalls++;
      if (this.closed) return this;
      this.closed = true;
      this.listening = false;
      this.emit("close");
      return this;
    }
    /** Drive a request the way Node would, capturing the response. */
    request(method, url) {
      const res = {
        statusCode: null,
        headers: null,
        body: "",
        writeHead(code, headers) { res.statusCode = code; res.headers = headers ?? null; },
        end(chunk) { if (chunk) res.body += chunk; res.ended = true; },
        ended: false,
      };
      this.handler({ method, url }, res);
      return res;
    }
  }
  export function createServer(handler) { return new FakeHttpServer(handler); }
`;

const STUBS = {
  "@earendil-works/pi-coding-agent": `export const VERSION = "0.84.2";`,
  "node:http": HTTP_STUB,
  http: HTTP_STUB,
  "@earendil-works/pi-tui": `export class Text { constructor(text) { this.text = text; } }`,
  typebox: `export const Type = {
    Object: () => ({}), String: () => ({}), Optional: (s) => s,
  };`,
  ws: `
    import { EventEmitter } from "node:events";
    export const sockets = [];
    export const servers = [];
    export class WebSocket extends EventEmitter {
      static OPEN = 1;
      constructor(url, options) {
        super();
        this.url = url;
        this.options = options;
        this.readyState = 1;
        this.sent = [];
        this.closed = false;
        sockets.push(this);
      }
      send(data) { this.sent.push(JSON.parse(data)); }
      // \`closed\` records that the owner asked to close. Set \`deferClose\` to hold the
      // resulting event back, the way a real abort delivers it on a later tick, and
      // release it with \`releaseClose()\`.
      close() {
        if (this.closed) return;
        this.closed = true;
        this.readyState = 3;
        if (this.deferClose) { this.closePending = true; return; }
        this.emit("close");
      }
      releaseClose() {
        if (!this.closePending) return;
        this.closePending = false;
        this.emit("close");
      }
    }
    export class WebSocketServer extends EventEmitter {
      constructor(options) {
        super();
        this.options = options;
        this.closed = false;
        servers.push(this);
        // Real ws forwards \`listening\` and \`error\` from a provided server
        // (8.21.3, websocket-server.js: addListeners). Hub election reads those
        // two events, so without forwarding it could not be tested at all.
        const provided = options && options.server;
        if (provided) {
          this.providedServer = provided;
          this._fwdListening = () => this.emit("listening");
          this._fwdError = (err) => this.emit("error", err);
          provided.on("listening", this._fwdListening);
          provided.on("error", this._fwdError);
        }
      }
      close() {
        if (this.closed) return;
        this.closed = true;
        // Real ws detaches its listeners and drops the reference but NEVER closes
        // a server it was handed \u2014 only an internally created one. A stub kinder
        // than this would make every teardown assertion below vacuous.
        if (this.providedServer) {
          this.providedServer.off("listening", this._fwdListening);
          this.providedServer.off("error", this._fwdError);
          this.providedServer = null;
        }
        this.emit("close");
      }
    }
  `,
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier in STUBS) return { url: `pi-link-stub:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("pi-link-stub:")) {
      return { format: "module", source: STUBS[url.slice("pi-link-stub:".length)], shortCircuit: true };
    }
    return next(url, context);
  },
});

const wsStub = await import("ws");
const httpStub = await import("node:http");
const createExtension = (await import(INDEX_URL)).default;

// Known-answer guard: if the resolve hook ever stopped intercepting `node:http`,
// every hub test would bind :9900 for real instead of failing visibly.
if (typeof httpStub.httpServers === "undefined") {
  console.error("FATAL: node:http is not stubbed — tests would bind a real port.");
  process.exit(1);
}

// ── Harness ─────────────────────────────────────────────────────────────────

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function until(predicate, what, ms = 2000) {
  for (let i = 0; i * 5 < ms; i++) {
    if (predicate()) return true;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Resolves once a reconnect fires, or after the 2-5s backoff ceiling. */
const RECONNECT_CEILING_MS = 6500;

// Every booted instance, so all of them can be shut down at the end.
const booted = [];

function boot({ link = false } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const notes = [];
  const entries = [];
  const delivered = [];
  let statusLine = "";

  const api = {
    registerFlag() {},
    getFlag: (name) => (name === "link" ? link : undefined),
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, options) { commands.set(name, options); },
    registerMessageRenderer() {},
    appendEntry(customType, data) { entries.push({ customType, data }); },
    getSessionName: () => undefined,
    setSessionName() {},
    sendMessage(message) { delivered.push(message); },
  };
  const ctx = {
    cwd: "C:/probe",
    ui: {
      theme: { fg: (_role, text) => text, bold: (text) => text },
      notify: (message) => notes.push(message),
      setStatus: (_key, text) => { statusLine = text; },
    },
    sessionManager: { getEntries: () => [] },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    compact() {},
  };

  const socketBase = wsStub.sockets.length;
  const serverBase = wsStub.servers.length;
  const httpBase = httpStub.httpServers.length;
  createExtension(api);

  const t = {
    notes,
    entries,
    delivered,
    status: () => statusLine,
    emit: async (event, payload = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
    cmd: (name, args = "") => commands.get(name).handler(args, ctx),
    tool: (name, params = {}) => tools.get(name).execute("probe", params),
    sockets: () => wsStub.sockets.slice(socketBase),
    servers: () => wsStub.servers.slice(serverBase),
    httpServers: () => httpStub.httpServers.slice(httpBase),
    /** "hub" | "client" | "disconnected", read from the real link_list tool. */
    role: async () => (await tools.get("link_list").execute("probe", {})).details?.role ?? "disconnected",
    start: async () => {
      await t.emit("session_start", { reason: "startup" });
      return t;
    },
  };
  booted.push({ t, ctx });
  return t;
}

/** A hub-side client socket: the shape `hubHandleClient` uses. */
function fakeIncoming() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.sent = [];
  socket.closed = false;
  socket.send = (data) => socket.sent.push(JSON.parse(data));
  socket.close = () => { socket.closed = true; socket.emit("close"); };
  socket.receive = (frame) => socket.emit("message", Buffer.from(JSON.stringify(frame)));
  return socket;
}

/** ws reports a failed or aborted dial as `error` then `close`. */
function failDial(socket) {
  socket.emit("error", new Error("ECONNREFUSED"));
  socket.close();
}

// Transports the test ends from the outside: a bind that never listened and a peer
// hangup. pi-link holds no closeable handle for either, so they are exempt from the
// teardown check below, which asserts it closes everything it does still hold.
const peerEnded = new Set();

function failBind(server) {
  peerEnded.add(server);
  // A bind that never listened holds no port, so pi-link has nothing to close on
  // the http server either — `settle` releases the handle and the object is done.
  if (server.providedServer) peerEnded.add(server.providedServer);
  server.emit("error", new Error("EADDRINUSE"));
}

function peerClose(socket) {
  peerEnded.add(socket);
  socket.emit("close");
}

/** Tracks settlement of a promise returned by /link-connect. */
function watch(promise) {
  const state = { settled: false };
  promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
}

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) { pass++; process.stdout.write("."); return; }
  fail++;
  failures.push(`${label}${detail ? `\n  ${detail}` : ""}`);
  process.stdout.write("F");
}

const registers = (socket) => socket.sent.filter((f) => f.type === "register");
const noteCount = (t, needle) => t.notes.filter((n) => n.includes(needle)).length;

/** Reads the link name without changing it: `/link-name` with no argument reports it. */
async function readName(t) {
  const before = t.notes.length;
  await t.cmd("link-name");
  return t.notes.slice(before).join(" ").match(/Current name: "([^"]+)"/)?.[1];
}

// ── 1. Single-flight initialization ─────────────────────────────────────────

{
  // Startup dial pending, then a manual /link-connect: one socket, both callers
  // settle on the same attempt, one register.
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  const joined = watch(t.cmd("link-connect"));
  await tick();
  check("1a: manual connect joins the pending startup attempt (1 socket)",
    t.sockets().length === 1, `sockets=${t.sockets().length}`);
  check("1a: joined caller has not settled while the dial is pending",
    joined.settled === false);
  t.sockets()[0].emit("open");
  await tick();
  check("1a: exactly one register after both callers", registers(t.sockets()[0]).length === 1,
    JSON.stringify(t.sockets()[0].sent));
  check("1a: joined caller settles with the attempt", joined.settled === true);
  check("1a: role is client", (await t.role()) === "client");
}

{
  // Timer + command: the reconnect timer must join the command's pending attempt
  // instead of dialling again.
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  failDial(t.sockets()[0]);
  await until(() => t.servers().length === 1, "the hub attempt");
  failBind(t.servers()[0]);
  await tick();
  check("1b: both phases failed -> no role", (await t.role()) === "disconnected");
  const manual = watch(t.cmd("link-connect"));
  await until(() => t.sockets().length === 2, "the command dial");
  const before = t.sockets().length;
  await new Promise((r) => setTimeout(r, RECONNECT_CEILING_MS));
  check("1b: the reconnect timer joined the in-flight attempt (no extra socket)",
    t.sockets().length === before, `sockets=${t.sockets().length} (expected ${before})`);
  check("1b: still exactly one pending server-phase-free dial",
    t.servers().length === 1, `servers=${t.servers().length}`);
  t.sockets()[1].emit("open");
  await tick();
  check("1b: the joined manual caller settles", manual.settled === true);
  check("1b: one register on the surviving dial", registers(t.sockets()[1]).length === 1);
}

// ── 2. Disconnect before the startup timer fires ────────────────────────────

{
  const t = boot({ link: true });
  const startPromise = t.start();
  await t.cmd("link-disconnect"); // lands before the 0ms startup callback
  await startPromise;
  await new Promise((r) => setTimeout(r, 60));
  check("2: disconnect before the startup timer constructs no transport",
    t.sockets().length === 0 && t.servers().length === 0,
    `sockets=${t.sockets().length} servers=${t.servers().length}`);
  check("2: persisted intent recorded", JSON.stringify(t.entries.at(-1)) === JSON.stringify({ customType: "link-active", data: { active: false } }),
    JSON.stringify(t.entries));
  check("2: notification is the disconnected-role wording",
    noteCount(t, "Link disconnected") === 1 && noteCount(t, "Disconnected from link hub") === 0,
    JSON.stringify(t.notes));
}

// ── 3. Late client callbacks after cancellation ─────────────────────────────

{
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  const attempt = watch(t.cmd("link-connect")); // handle on the same attempt
  await tick();
  const socket = t.sockets()[0];
  const nameBefore = await readName(t);
  await t.cmd("link-disconnect");
  await tick();
  check("3: cancellation physically closed the pending dial", socket.closed === true);
  check("3: the cancelled attempt settled", attempt.settled === true);

  socket.emit("open"); // late handshake
  // A stale `welcome` is the interesting message: accepting it would rename this
  // terminal and adopt the sender's membership without ever calling sendMessage.
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "welcome", name: "ghost", terminals: ["ghost", "peer"],
  })));
  socket.emit("close");
  await tick();
  check("3: late open sends no register", registers(socket).length === 0, JSON.stringify(socket.sent));
  check("3: late callbacks leave the role alone", (await t.role()) === "disconnected");
  check("3: stale welcome is not acknowledged", noteCount(t, "Joined link") === 0, JSON.stringify(t.notes));
  check("3: stale welcome does not rename the terminal",
    (await readName(t)) === nameBefore, `${nameBefore} -> ${await readName(t)}`);
  check("3: no reconnect was scheduled", t.sockets().length === 1 && t.servers().length === 0,
    `sockets=${t.sockets().length} servers=${t.servers().length}`);
  check("3: no hub-disconnect warning was published", noteCount(t, "Disconnected from link hub") === 0,
    JSON.stringify(t.notes));

  // Membership is only observable once connected, so reconnect and look: a stale
  // welcome that had been accepted would show up here as ghost peers.
  const reconnected = t.cmd("link-connect");
  await until(() => t.sockets().length === 2, "a fresh dial");
  t.sockets()[1].emit("open");
  await reconnected;
  const list = (await t.tool("link_list")).details;
  check("3: stale welcome left no membership or identity behind",
    list.self === nameBefore && list.terminals.length === 0, JSON.stringify(list));
  check("3: the fresh dial registers under the unchanged name",
    registers(t.sockets()[1])[0]?.name === nameBefore, JSON.stringify(t.sockets()[1].sent));
}

// ── 4. Client failure → hub transfer, exactly once ──────────────────────────

{
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  failDial(t.sockets()[0]); // error AND close, ws's real sequence
  await until(() => t.servers().length === 1, "the hub attempt");
  await tick();
  check("4: error+close falls back exactly once (one server)",
    t.servers().length === 1 && t.sockets().length === 1,
    `sockets=${t.sockets().length} servers=${t.servers().length}`);
  t.servers()[0].emit("listening");
  await tick();
  check("4: current listening commits the hub", (await t.role()) === "hub");
  check("4: hub announced exactly once", noteCount(t, "hub started") === 1, JSON.stringify(t.notes));
  check("4: no second attempt or owner gap (one socket, one server)",
    t.sockets().length === 1 && t.servers().length === 1,
    `sockets=${t.sockets().length} servers=${t.servers().length}`);
  // The established hub, not a leftover attempt, is what accepts clients.
  const incoming = fakeIncoming();
  t.servers()[0].emit("connection", incoming);
  incoming.receive({ type: "register", name: "peer" });
  await tick();
  check("4: the transferred server is the one serving clients",
    incoming.closed === false && incoming.sent.some((f) => f.type === "welcome"),
    JSON.stringify(incoming.sent));
}

// ── 5. Pending hub cancellation, adversarial callback order ─────────────────

{
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  const attempt = watch(t.cmd("link-connect"));
  failDial(t.sockets()[0]);
  await until(() => t.servers().length === 1, "the hub attempt");
  const server = t.servers()[0];
  await t.cmd("link-disconnect");
  await tick();
  check("5: cancellation closed the pending server", server.closed === true);
  check("5: the cancelled attempt settled", attempt.settled === true);

  server.emit("listening");
  const incoming = fakeIncoming();
  server.emit("connection", incoming);
  incoming.receive({ type: "register", name: "peer" });
  server.emit("error", new Error("late"));
  server.emit("close");
  await tick();
  check("5: late listening does not become hub", (await t.role()) === "disconnected");
  check("5: no hub announcement", noteCount(t, "hub started") === 0, JSON.stringify(t.notes));
  check("5: a cancelled listener refuses the client", incoming.closed === true);
  check("5: refused client got no welcome", incoming.sent.length === 0, JSON.stringify(incoming.sent));
  check("5: a cancelled attempt schedules no retry",
    t.sockets().length === 1 && t.servers().length === 1,
    `sockets=${t.sockets().length} servers=${t.servers().length}`);
}

// ── 6. Stale established socket cannot affect the new connection ────────────

{
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  const old = t.sockets()[0];
  old.emit("open");
  await tick();
  check("6: first client established", (await t.role()) === "client");
  await t.cmd("link-disconnect");
  await tick();
  const reconnected = t.cmd("link-connect"); // settles only once the dial resolves
  await until(() => t.sockets().length === 2, "the reconnect dial");
  const fresh = t.sockets()[1];
  fresh.emit("open");
  await reconnected;
  await tick();
  fresh.emit("message", Buffer.from(JSON.stringify({ type: "welcome", name: "me", terminals: ["me", "peer"] })));
  await tick();
  check("6: the new client is established and welcomed",
    (await t.role()) === "client" && (await t.tool("link_list")).details.terminals.length === 2,
    JSON.stringify((await t.tool("link_list")).details));

  t.notes.length = 0;
  t.delivered.length = 0;
  old.emit("message", Buffer.from(JSON.stringify({ type: "chat", from: "peer", to: "me", content: "stale" })));
  old.emit("close");
  await new Promise((r) => setTimeout(r, 300));
  check("6: stale message never reaches the model", t.delivered.length === 0, JSON.stringify(t.delivered));
  check("6: stale close leaves the new client established", (await t.role()) === "client");
  check("6: stale close publishes no warning", noteCount(t, "Disconnected from link hub") === 0,
    JSON.stringify(t.notes));
  check("6: stale close schedules no reconnect", t.sockets().length === 2,
    `sockets=${t.sockets().length}`);
}

// ── 7. Attempt A cannot clear owner B ───────────────────────────────────────

{
  const t = boot({ link: false });
  await t.start();
  const a = watch(t.cmd("link-connect"));
  await until(() => t.sockets().length === 1, "attempt A's dial");
  const socketA = t.sockets()[0];
  // Hold A's close event back, so A's task is still parked when B takes over and
  // its finalizer runs against a live owner rather than against nobody.
  socketA.deferClose = true;
  await t.cmd("link-disconnect"); // cancels A: close requested, event outstanding
  await tick();
  check("7: cancellation requested A's close", socketA.closed === true);
  check("7: A is still unsettled while its close event is outstanding",
    a.settled === false);

  const b = watch(t.cmd("link-connect")); // B starts while A is still awaiting close
  await until(() => t.sockets().length === 2, "attempt B's dial");
  const socketB = t.sockets()[1];
  check("7: B started while A was unsettled", b.settled === false);

  socketA.releaseClose(); // A's phase resolves; runAttempt(A) now runs its finalizer
  await tick();
  check("7: A settles only once its close arrives", a.settled === true);

  // The decisive assertion: if A's finalizer had cleared the owner slot
  // unconditionally, this caller would start a third attempt instead of joining B.
  const joined = watch(t.cmd("link-connect"));
  await tick();
  check("7: A's finalizer left B as the owner (caller joins, no third socket)",
    t.sockets().length === 2 && joined.settled === false,
    `sockets=${t.sockets().length} joinedSettled=${joined.settled}`);

  socketA.emit("open");
  socketA.emit("message", Buffer.from(JSON.stringify({ type: "welcome", name: "ghost", terminals: ["ghost"] })));
  socketA.emit("error", new Error("late"));
  await tick();
  check("7: A's callbacks send no register", registers(socketA).length === 0);
  check("7: A's callbacks do not settle B", b.settled === false);
  check("7: A's callbacks do not close B's socket", socketB.closed === false);
  check("7: role still disconnected while B is pending", (await t.role()) === "disconnected");

  socketB.emit("open");
  await tick();
  check("7: B still establishes normally after A's noise",
    b.settled === true && joined.settled === true &&
      registers(socketB).length === 1 && (await t.role()) === "client",
    JSON.stringify(socketB.sent));
}

// ── 8. Bounded opening handshake ────────────────────────────────────────────

{
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  const socket = t.sockets()[0];
  check("8: the dial carries handshakeTimeout: 5000",
    socket.options?.handshakeTimeout === 5000, JSON.stringify(socket.options));
  check("8: the dial targets the loopback link port",
    socket.url === "ws://127.0.0.1:9900", socket.url);
  // ws reports a handshake timeout by aborting: error then close.
  socket.emit("error", new Error("Opening handshake has timed out"));
  socket.close();
  await until(() => t.servers().length === 1, "the hub fallback");
  check("8: a timed-out handshake falls back to the hub exactly once",
    t.servers().length === 1 && t.sockets().length === 1,
    `sockets=${t.sockets().length} servers=${t.servers().length}`);
  failBind(t.servers()[0]);
  await until(() => t.sockets().length === 2, "the single reconnect", RECONNECT_CEILING_MS);
  await new Promise((r) => setTimeout(r, 200));
  check("8: EADDRINUSE schedules exactly one reconnect",
    t.sockets().length === 2 && t.servers().length === 1,
    `sockets=${t.sockets().length} servers=${t.servers().length}`);
}

// ── 9. Shutdown with pending transports ─────────────────────────────────────

{
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  const attempt = watch(t.cmd("link-connect"));
  const socket = t.sockets()[0];
  await t.emit("session_shutdown", { reason: "quit" });
  await tick();
  check("9a: shutdown closes the pending dial and settles it",
    socket.closed === true && attempt.settled === true);
  socket.emit("open");
  await tick();
  check("9a: post-shutdown open is inert", registers(socket).length === 0);
}

{
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  const attempt = watch(t.cmd("link-connect"));
  failDial(t.sockets()[0]);
  await until(() => t.servers().length === 1, "the hub attempt");
  const server = t.servers()[0];
  await t.emit("session_shutdown", { reason: "quit" });
  await tick();
  check("9b: shutdown closes the pending server and settles it",
    server.closed === true && attempt.settled === true);
  server.emit("listening");
  const incoming = fakeIncoming();
  server.emit("connection", incoming);
  await tick();
  check("9b: post-shutdown listening is inert",
    (await t.role()) === "disconnected" && noteCount(t, "hub started") === 0,
    JSON.stringify(t.notes));
  check("9b: post-shutdown connection is refused", incoming.closed === true);
}

// ── 10. Normal controls ─────────────────────────────────────────────────────

{
  // Client join: register, welcome, membership, status push.
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  const socket = t.sockets()[0];
  socket.emit("open");
  await tick();
  const register = registers(socket)[0];
  check("10a: register carries name and cwd",
    register?.name?.startsWith("t-") && register.cwd === "C:/probe", JSON.stringify(register));
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "welcome", name: "opus", terminals: ["opus", "peer"],
  })));
  await tick();
  check("10a: welcome is accepted on the established socket",
    noteCount(t, 'Joined link as "opus"') === 1, JSON.stringify(t.notes));
  socket.sent.length = 0;
  await t.emit("agent_start");
  await tick();
  check("10a: status pushes go out on the established socket",
    socket.sent.length === 1 && socket.sent[0].type === "status_update",
    JSON.stringify(socket.sent));
  // An unexpected close of the current socket must warn once and reconnect once.
  peerClose(socket);
  await tick();
  check("10a: current close warns exactly once",
    noteCount(t, "Disconnected from link hub") === 1, JSON.stringify(t.notes));
  await until(() => t.sockets().length === 2, "exactly one reconnect", RECONNECT_CEILING_MS);
  await new Promise((r) => setTimeout(r, 200));
  check("10a: current close schedules exactly one reconnect",
    t.sockets().length === 2, `sockets=${t.sockets().length}`);
}

{
  // Hub promotion and client adoption.
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  failDial(t.sockets()[0]);
  await until(() => t.servers().length === 1, "the hub attempt");
  const server = t.servers()[0];
  server.emit("listening");
  await tick();
  check("10b: hub promotion sets the hub role and status",
    (await t.role()) === "hub" && /\(hub\)/.test(t.status()), t.status());
  const incoming = fakeIncoming();
  server.emit("connection", incoming);
  incoming.receive({ type: "register", name: "peer" });
  await tick();
  const welcome = incoming.sent.find((f) => f.type === "welcome");
  check("10b: the established hub adopts and welcomes a client",
    welcome?.name === "peer" && welcome.terminals.length === 2, JSON.stringify(incoming.sent));
  check("10b: /link-connect on an established role reports it",
    (await (async () => { t.notes.length = 0; await t.cmd("link-connect"); return noteCount(t, "Already connected"); })()) === 1,
    JSON.stringify(t.notes));
}

{
  // Disconnect while established: wording and persistence differ from the
  // disconnected-role branch, and the hub is torn down.
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  failDial(t.sockets()[0]);
  await until(() => t.servers().length === 1, "the hub attempt");
  t.servers()[0].emit("listening");
  await tick();
  t.notes.length = 0;
  await t.cmd("link-disconnect");
  await tick();
  check("10c: established disconnect uses the connected wording",
    noteCount(t, "Disconnected from link") === 1 && noteCount(t, "Link disconnected") === 0,
    JSON.stringify(t.notes));
  check("10c: established disconnect persists intent and closes the hub",
    JSON.stringify(t.entries.at(-1)) === JSON.stringify({ customType: "link-active", data: { active: false } }) &&
      t.servers()[0].closed === true && (await t.role()) === "disconnected",
    JSON.stringify(t.entries.at(-1)));
}

{
  // Client rename: reconnect requests the new preferred name.
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  t.sockets()[0].emit("open");
  await tick();
  t.sockets()[0].emit("message", Buffer.from(JSON.stringify({
    type: "welcome", name: "before", terminals: ["before"],
  })));
  await tick();
  t.notes.length = 0;
  await t.cmd("link-name", "after");
  await tick();
  check("10d: rename persists the preference and announces the reconnect",
    JSON.stringify(t.entries.at(-1)) === JSON.stringify({ customType: "link-name", data: { name: "after" } }) &&
      noteCount(t, 'requesting "after"') === 1,
    `${JSON.stringify(t.entries.at(-1))} ${JSON.stringify(t.notes)}`);
  await until(() => t.sockets().length === 2, "the rename reconnect", RECONNECT_CEILING_MS);
  t.sockets()[1].emit("open");
  await tick();
  check("10d: the reconnect registers with the requested name",
    registers(t.sockets()[1])[0]?.name === "after", JSON.stringify(t.sockets()[1].sent));
}

// ── 11. Hub `GET /status`: the endpoint, and the handle that serves it ──────

/** Bring a terminal up as an established hub and hand back its two servers. */
async function bootHub() {
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  failDial(t.sockets()[0]);
  await until(() => t.servers().length === 1, "the hub attempt");
  const http = t.httpServers()[0];
  http.emit("listening"); // forwarded to the wss, exactly as ws 8.21.3 does
  await tick();
  // The harness names each terminal randomly, so read the name rather than fix it.
  const self = (await t.tool("link_list")).details.self;
  return { t, http, server: t.servers()[0], self };
}

const getStatus = (http) => {
  const res = http.request("GET", "/status");
  return { res, body: JSON.parse(res.body) };
};

{
  const { t, http, server, self } = await bootHub();

  check("11: the provided server is the one that listens on the link port",
    JSON.stringify(http.listenArgs) === JSON.stringify([9900, "127.0.0.1"]),
    JSON.stringify(http.listenArgs));
  check("11: forwarded listening committed the hub", (await t.role()) === "hub");
  check("11: the ws server was handed the http server",
    server.options?.server === http && server.options?.port === undefined,
    JSON.stringify(Object.keys(server.options ?? {})));

  const { res, body } = getStatus(http);
  check("11: GET /status answers 200 JSON",
    res.statusCode === 200 && res.headers?.["content-type"] === "application/json" && res.ended,
    `${res.statusCode} ${JSON.stringify(res.headers)}`);
  check("11: payload carries hub name and port",
    body.hub === self && body.port === 9900, JSON.stringify(body));
  check("11: the hub is the first terminal and is labelled hub",
    body.terminals[0].name === self && body.terminals[0].role === "hub",
    JSON.stringify(body.terminals));
  check("11: the hub reports its own live status and context",
    body.terminals[0].status === "idle" &&
      typeof body.terminals[0].sinceSeconds === "number" &&
      body.terminals[0].context.tokens === 10 &&
      body.terminals[0].context.window === 100,
    JSON.stringify(body.terminals[0]));
  check("11: the hub reports its cwd", body.terminals[0].cwd === "C:/probe",
    JSON.stringify(body.terminals[0]));

  // Other paths and other methods are not the endpoint.
  const notFound = [
    http.request("GET", "/"),
    http.request("GET", "/statuses"),
    http.request("GET", "/status?x=1"),
    http.request("POST", "/status"),
    http.request("DELETE", "/status"),
  ];
  check("11: every other path and method is 404 with no body",
    notFound.every((r) => r.statusCode === 404 && r.body === "" && r.ended),
    JSON.stringify(notFound.map((r) => r.statusCode)));
}

{
  const { t, http, server, self } = await bootHub();

  // Two clients, registered out of alphabetical order.
  const zeta = fakeIncoming();
  server.emit("connection", zeta);
  zeta.receive({ type: "register", name: "zeta", cwd: "C:/zeta" });
  const alpha = fakeIncoming();
  server.emit("connection", alpha);
  alpha.receive({ type: "register", name: "alpha" });
  await tick();

  // All four status kinds, driven over the wire the way a real peer reports them.
  const since = Date.now() - 5_000;
  alpha.receive({
    type: "status_update",
    status: { kind: "thinking", since },
    context: { tokens: null, contextWindow: 200 },
  });
  await tick();

  const { body } = getStatus(http);
  check("11: hub first, then clients sorted by name",
    body.terminals.map((e) => e.name).join(",") === `${self},alpha,zeta`,
    JSON.stringify(body.terminals.map((e) => e.name)));
  check("11: clients are labelled client",
    body.terminals.slice(1).every((e) => e.role === "client"),
    JSON.stringify(body.terminals));

  const a = body.terminals.find((e) => e.name === "alpha");
  check("11: a reported status is flattened and dated",
    a.status === "thinking" && a.sinceSeconds === 5, JSON.stringify(a));
  check("11: tokens null survives as null, window is renamed from contextWindow",
    a.context.tokens === null && a.context.window === 200, JSON.stringify(a));
  check("11: a client that sent no cwd omits the field", !("cwd" in a), JSON.stringify(a));

  const z = body.terminals.find((e) => e.name === "zeta");
  check("11: a client heard from but not yet reporting omits status, never invents idle",
    !("status" in z) && !("sinceSeconds" in z), JSON.stringify(z));
  check("11: no context snapshot renders the whole field null", z.context === null, JSON.stringify(z));
  check("11: a client cwd from register is reported", z.cwd === "C:/zeta", JSON.stringify(z));

  for (const [kind, expected] of [
    [{ kind: "compacting", since }, "compacting"],
    [{ kind: "tool", toolName: "link_send", since }, "tool:link_send"],
    [{ kind: "idle", since }, "idle"],
  ]) {
    alpha.receive({ type: "status_update", status: kind });
    await tick();
    const seen = getStatus(http).body.terminals.find((e) => e.name === "alpha").status;
    check(`11: status kind ${expected} is reported verbatim`, seen === expected, seen);
  }

  // Read-only: observing the link must not disturb it.
  const before = {
    terminals: (await t.tool("link_list")).details.terminals.join(","),
    zetaFrames: zeta.sent.length,
    alphaFrames: alpha.sent.length,
  };
  for (let i = 0; i < 3; i++) getStatus(http);
  await tick();
  const after = (await t.tool("link_list")).details.terminals.join(",");
  check("11: /status broadcasts nothing to clients",
    zeta.sent.length === before.zetaFrames && alpha.sent.length === before.alphaFrames,
    `zeta ${before.zetaFrames}->${zeta.sent.length} alpha ${before.alphaFrames}->${alpha.sent.length}`);
  check("11: /status leaves membership untouched", after === before.terminals,
    `${before.terminals} -> ${after}`);
  check("11: clients stay connected across polling",
    zeta.closed === false && alpha.closed === false);
}

// The invariant the three teardown sites exist for: closing the ws server does
// not close a server it was handed, so pi-link must close it at every exit.
{
  const { http, server } = await bootHub();
  server.close();
  await tick();
  check("11: wss.close() alone leaves the provided http server open",
    server.closed === true && http.closed === false);
  check("11: and ws has detached its forwarding listeners",
    server.providedServer === null);
}

// Site 1 — listening arrives after the attempt was cancelled.
{
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  failDial(t.sockets()[0]);
  await until(() => t.servers().length === 1, "the hub attempt");
  const http = t.httpServers()[0];
  const server = t.servers()[0];
  await t.cmd("link-disconnect");
  await tick();
  // Cancellation has already closed this server, and `ws` detached its forwarding
  // on `wss.close()` — so a forwarded `listening` can no longer reach the branch.
  // Drive the wss directly, the way the older adversarial tests do: that is the
  // only route to this close site, and only the call count can observe it.
  const closesBefore = http.closeCalls;
  server.emit("listening");
  await tick();
  check("11: the stale-listening branch closes the http server itself",
    http.closeCalls === closesBefore + 1, `${closesBefore} -> ${http.closeCalls}`);
  check("11: late listening does not make it the hub", (await t.role()) === "disconnected");
}

// Site 2 — cancellation while the bind is still pending.
{
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  failDial(t.sockets()[0]);
  await until(() => t.servers().length === 1, "the hub attempt");
  const http = t.httpServers()[0];
  check("11: the pending http server is open before cancellation", http.closed === false);
  await t.cmd("link-disconnect");
  await tick();
  check("11: cancelConnectionAttempt closes the pending http server", http.closed === true);
}

// Site 3 — an established hub disconnecting must free the port.
{
  const { t, http, server } = await bootHub();
  check("11: the established hub's http server is open", http.closed === false);
  await t.cmd("link-disconnect");
  await tick();
  check("11: disconnect closes the established http server", http.closed === true);
  check("11: disconnect closed the ws server too", server.closed === true);
  check("11: the hub is no longer serving", (await t.role()) === "disconnected");
}

// Election: a bind failure forwarded from the provided server still falls back.
{
  const t = await boot({ link: true }).start();
  await until(() => t.sockets().length === 1, "the startup dial");
  failDial(t.sockets()[0]);
  await until(() => t.servers().length === 1, "the hub attempt");
  const http = t.httpServers()[0];
  peerEnded.add(t.servers()[0]);
  peerEnded.add(http);
  http.emit("error", Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
  await until(() => t.sockets().length === 2, "the single reconnect", RECONNECT_CEILING_MS);
  await new Promise((r) => setTimeout(r, 200));
  check("11: EADDRINUSE forwarded from the http server falls back to client, once",
    t.sockets().length === 2 && t.servers().length === 1,
    `sockets=${t.sockets().length} servers=${t.servers().length}`);
  check("11: a failed bind never became the hub", (await t.role()) !== "hub");
}

// ── Teardown: every instance closes its own transports and timers ───────────

for (const { t, ctx } of booted) await t.emit("session_shutdown", { reason: "quit" }, ctx);

const stillOpen = (transports) =>
  transports
    .map((transport, index) => ({ transport, index }))
    .filter(({ transport }) => !peerEnded.has(transport) && !transport.closed)
    .map(({ index }) => index);
const leakedSockets = stillOpen(wsStub.sockets);
const leakedServers = stillOpen(wsStub.servers);
// An unclosed http server is the one leak that outlives the process's usefulness:
// it squats :9900 and no other terminal can ever become hub.
const leakedHttp = stillOpen(httpStub.httpServers);
check(
  `teardown: pi-link closed every transport it held (${wsStub.sockets.length} sockets, ${wsStub.servers.length} servers, ${httpStub.httpServers.length} http)`,
  leakedSockets.length === 0 && leakedServers.length === 0 && leakedHttp.length === 0,
  `still open: sockets ${JSON.stringify(leakedSockets)} servers ${JSON.stringify(leakedServers)} http ${JSON.stringify(leakedHttp)}`,
);

console.log(`\n\nPassed: ${pass}`);
console.log(`Failed: ${fail}`);
for (const f of failures) console.log("  - " + f);
process.exitCode = fail === 0 ? 0 : 1;
