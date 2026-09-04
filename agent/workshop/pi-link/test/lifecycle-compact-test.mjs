#!/usr/bin/env node

// Behavior tests for pi-link's remote-compaction guard and settled lifecycle.
//
// The real extension is loaded and driven through its real event handlers and its
// real hub routing. Only the four modules Pi supplies are stubbed, in-process:
// `ws` never opens a socket (no port is bound and the live mesh is untouched),
// `@earendil-works/pi-coding-agent` exports a mutable VERSION so the compatibility
// floor can be probed, and pi-tui/typebox are the two values the module needs at
// load time.
//
// Usage: node test/lifecycle-compact-test.mjs
// Requires Node 22.18+ or 24+ (module.registerHooks and TypeScript type stripping).

import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const INDEX_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"),
).href;

// ── Stubs for the modules Pi provides ───────────────────────────────────────

const HTTP_STUB = `
  import { EventEmitter } from "node:events";
  export const httpServers = [];
  class FakeHttpServer extends EventEmitter {
    constructor(handler) {
      super();
      this.handler = handler;
      this.listening = false;
      this.closed = false;
      httpServers.push(this);
    }
    listen(...args) { this.listenArgs = args; this.listening = true; return this; }
    close() {
      if (this.closed) return this;
      this.closed = true;
      this.listening = false;
      this.emit("close");
      return this;
    }
  }
  export function createServer(handler) { return new FakeHttpServer(handler); }
`;

const STUBS = {
  "@earendil-works/pi-coding-agent": `
    export let VERSION = "0.84.2";
    export function __setVersion(v) { VERSION = v; }
  `,
  "@earendil-works/pi-tui": `export class Text { constructor(text) { this.text = text; } }`,
  typebox: `export const Type = {
    Object: () => ({}), String: () => ({}), Optional: (s) => s,
  };`,
  ws: `
    import { EventEmitter } from "node:events";
    export const servers = [];
    // Dialling always fails, so the extension falls through to becoming the hub —
    // the same path it takes on a free port, without opening one.
    export class WebSocket extends EventEmitter {
      static OPEN = 1;
      constructor() {
        super();
        this.readyState = 1;
        setTimeout(() => this.emit("error", new Error("ECONNREFUSED")), 0);
      }
      send() {}
      close() { this.readyState = 3; this.emit("close"); }
    }
    export class WebSocketServer extends EventEmitter {
      constructor() { super(); servers.push(this); setTimeout(() => this.emit("listening"), 0); }
      close() {}
    }
  `,
  // The hub owns an HTTP server so it can answer `GET /status`. Stubbed under both
  // specifier spellings so no suite can ever bind a real port.
  "node:http": HTTP_STUB,
  http: HTTP_STUB,
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

const piStub = await import("@earendil-works/pi-coding-agent");
const wsStub = await import("ws");
const createExtension = (await import(INDEX_URL)).default;

// ── Harness ─────────────────────────────────────────────────────────────────

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function waitFor(predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Records what the extension registers, and lets a test fire Pi events at it. */
function fakePi() {
  const handlers = new Map();
  const api = {
    registrations: 0,
    sentMessages: [],
    registerFlag() { api.registrations++; },
    getFlag(name) { return name === "link"; },
    on(event, handler) {
      api.registrations++;
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() { api.registrations++; },
    registerCommand() { api.registrations++; },
    registerMessageRenderer() { api.registrations++; },
    appendEntry() {},
    getSessionName() { return undefined; },
    setSessionName() {},
    sendMessage(message, options) { api.sentMessages.push({ message, options }); },
    async emit(event, payload, ctx) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
  return api;
}

/** A hub-side client socket: the shape `hubHandleClient` actually uses. */
function fakeClient() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.sent = [];
  socket.send = (data) => socket.sent.push(JSON.parse(data));
  socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  socket.receive = (frame) => socket.emit("message", Buffer.from(JSON.stringify(frame)));
  return socket;
}

/** A minimal ExtensionContext: only the members the extension actually reads. */
function fakeCtx(overrides = {}) {
  const notes = [];
  return {
    notes,
    cwd: "C:/test/cwd",
    ui: {
      theme: { fg: (_role, text) => text, bold: (text) => text },
      notify(message) { notes.push(message); },
      setStatus() {},
    },
    sessionManager: { getEntries: () => [] },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    compact() { throw new Error("compact() called unexpectedly"); },
    ...overrides,
  };
}

// Every instance booted below, so all of them can be shut down at the end.
const booted = [];

/**
 * Boot one extension instance as a hub with one registered fake client, and
 * return the handles a test needs: the client's received frames, a way to push
 * frames from that client, and the Pi event emitter.
 */
async function boot(ctxOverrides = {}) {
  const api = fakePi();
  const ctx = fakeCtx(ctxOverrides);
  booted.push({ api, ctx });
  const serverIndex = wsStub.servers.length;
  createExtension(api);
  await api.emit("session_start", { reason: "startup" }, ctx);
  // Startup connect: the dial fails, so this instance becomes the hub. Wait for the
  // hub to be listening, not merely constructed — the role is set on `listening`.
  await waitFor(
    () => ctx.notes.some((note) => note.includes("hub started")),
    "the hub to start listening",
  );

  const client = fakeClient();
  wsStub.servers[serverIndex].emit("connection", client);
  client.receive({ type: "register", name: "peer" });
  const welcome = client.sent.find((frame) => frame.type === "welcome");
  if (!welcome) throw new Error("hub did not welcome the fake client");
  const self = welcome.terminals.find((name) => name !== welcome.name);
  return { api, ctx, client, frames: client.sent, self };
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

const frameOf = (frames, type) => frames.filter((f) => f.type === type);
const statuses = (frames) => frameOf(frames, "status_update").map((f) => f.status.kind);
const responses = (frames) => frameOf(frames, "compact_response");

// ── A. Compatibility floor ──────────────────────────────────────────────────

for (const [version, supported] of [
  ["0.84.2", true],
  ["0.84.3", true],
  ["0.85.0", true],
  ["1.0.0", true],
  ["0.85.0-beta.1", true],
  ["0.84.2+build.1", true], // build metadata carries no precedence
  ["0.85.0+vendor.1", true],
  ["0.85.0-0", true], // a single zero is a legal numeric identifier
  ["0.84.1", false],
  ["0.83.9", false],
  ["0.84.2-beta.1", false], // a prerelease of the floor precedes it
  ["0.84.2-beta.1+build.2", false],
  ["00.84.2", false], // leading zeros are not SemVer numeric identifiers
  ["0.084.2", false],
  ["0.85.0-01", false], // nor in a numeric prerelease identifier
  ["0.84.2+.", false], // suffix identifiers cannot be empty
  ["0.85.0-alpha..1", false],
  ["99999999999999999999.0.0", false], // too large to compare exactly
  ["not.a.version", false],
  ["", false],
]) {
  piStub.__setVersion(version);
  const api = fakePi();
  let error;
  try { createExtension(api); } catch (e) { error = e; }
  check(
    `A: Pi ${version || "(empty)"} ${supported ? "accepted" : "refused"}`,
    supported ? error === undefined && api.registrations > 0 : error !== undefined && api.registrations === 0,
    `error=${error?.message ?? "none"}, registrations=${api.registrations}`,
  );
  if (!supported && error) {
    check(
      `A: Pi ${version || "(empty)"} error names floor and detected version`,
      error.message.includes("0.84.2") && error.message.includes(version || "unknown"),
      error.message,
    );
  }
}
piStub.__setVersion("0.84.2");

// ── B. Remote compaction guard matrix ───────────────────────────────────────

const compactRequest = ({ client, self }, id = "r1") =>
  client.receive({ type: "compact_request", id, from: "peer", to: self });

{
  // 1. Capability absent -> unsupported, no compact call.
  const hub = await boot({ compact: undefined });
  compactRequest(hub);
  await tick();
  const [res] = responses(hub.frames);
  check("B1: no compact capability -> unsupported", res?.ok === false && res?.reason === "unsupported", JSON.stringify(res));
}

{
  // 2. Not idle, gates clear -> busy, no compact call.
  let calls = 0;
  const hub = await boot({ isIdle: () => false, compact: () => { calls++; } });
  compactRequest(hub);
  await tick();
  const [res] = responses(hub.frames);
  check("B2: Pi not idle -> busy, no compact()", res?.reason === "busy" && calls === 0, `${JSON.stringify(res)} calls=${calls}`);
}

{
  // 3. Idle but a manual compaction holds the gate -> busy. This raises the real
  // gate, including its 180s deadline; the shutdown at the end of the file is what
  // clears it, and the process exiting on its own is the proof.
  let calls = 0;
  const hub = await boot({ compact: () => { calls++; } });
  await hub.api.emit("session_before_compact", { reason: "manual" }, hub.ctx);
  compactRequest(hub);
  await tick();
  const [res] = responses(hub.frames);
  check("B3: idle + manual gate -> busy, no compact()", res?.reason === "busy" && calls === 0, `${JSON.stringify(res)} calls=${calls}`);
}

{
  // 4/5. Idle and ungated -> exactly one compact(); a second request is busy;
  // completion answers the first request.
  let calls = 0;
  let complete;
  const hub = await boot({
    compact: (options) => { calls++; complete = options.onComplete; },
  });
  const frames = hub.frames;
  compactRequest(hub, "first");
  await tick();
  check("B5: idle + ungated -> one compact() call", calls === 1, `calls=${calls}`);
  compactRequest(hub, "second");
  await tick();
  const second = responses(frames).find((r) => r.id === "second");
  check("B4: request during our own compaction -> busy, no second compact()", second?.reason === "busy" && calls === 1, `${JSON.stringify(second)} calls=${calls}`);
  check("B5: compacting terminal reports compacting", statuses(frames).includes("compacting"), statuses(frames).join(","));
  complete?.({});
  await tick();
  const first = responses(frames).find((r) => r.id === "first");
  check("B5: completion answers the accepted request", first?.ok === true, JSON.stringify(first));
}

// ── C. Settled lifecycle ────────────────────────────────────────────────────

{
  const { api, ctx, frames } = await boot();
  frames.length = 0;
  await api.emit("agent_start", {}, ctx);
  await api.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash" }, ctx);
  await api.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash" }, ctx);
  await api.emit("agent_end", { messages: [] }, ctx);
  check(
    "C1: agent_end stays thinking (no idle before settlement)",
    statuses(frames).join(",") === "thinking,tool,thinking",
    statuses(frames).join(","),
  );
  await api.emit("agent_settled", {}, ctx);
  check("C1: agent_settled publishes idle once", statuses(frames).join(",") === "thinking,tool,thinking,idle", statuses(frames).join(","));
}

{
  // A tool call left unmatched at agent_end must fall back to thinking, not stay pinned.
  const { api, ctx, frames } = await boot();
  await api.emit("agent_start", {}, ctx);
  await api.emit("tool_execution_start", { toolCallId: "t1", toolName: "read" }, ctx);
  frames.length = 0;
  await api.emit("agent_end", { messages: [] }, ctx);
  check("C2: stale tool at agent_end -> thinking", statuses(frames).join(",") === "thinking", statuses(frames).join(","));
}

{
  // Settlement that finds Pi busy again must not publish idle or clear the newer run.
  const { api, frames } = await boot();
  const busyCtx = fakeCtx({ isIdle: () => false });
  await api.emit("agent_start", {}, busyCtx);
  frames.length = 0;
  await api.emit("agent_settled", {}, busyCtx);
  check("C3: settled while a newer run is active -> no idle", statuses(frames).length === 0, statuses(frames).join(","));
}

{
  // Automatic compaction is never labelled compacting, and stays thinking.
  const { api, ctx, frames } = await boot();
  await api.emit("agent_start", {}, ctx);
  await api.emit("agent_end", { messages: [] }, ctx);
  frames.length = 0;
  await api.emit("session_before_compact", { reason: "threshold" }, ctx);
  await api.emit("session_compact", { reason: "threshold" }, ctx);
  // session_compact force-pushes, so there is a status to inspect and the
  // assertion cannot pass by finding nothing.
  const kinds = statuses(frames);
  check(
    "C4: automatic compaction stays thinking until settled, never compacting",
    kinds.length > 0 && kinds.every((k) => k === "thinking"),
    kinds.join(","),
  );
}

{
  // Inbox delivery is untouched by the lifecycle change: a chat still lands.
  const { api, client, self } = await boot();
  client.receive({ type: "chat", from: "peer", to: self, content: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  check(
    "C5: link_send delivery unchanged",
    api.sentMessages.length === 1 && api.sentMessages[0].options.triggerTurn === true &&
      api.sentMessages[0].message.content.includes('From "peer"'),
    JSON.stringify(api.sentMessages),
  );
}

// Shut every booted instance down through the real lifecycle. Without this the
// manual gate raised in B3 holds a 180-second deadline, and the process only exits
// on its own once every instance has cleaned up its timers and sockets.
for (const { api, ctx } of booted) await api.emit("session_shutdown", {}, ctx);

console.log(`\n\nPassed: ${pass}`);
console.log(`Failed: ${fail}`);
for (const f of failures) console.log("  - " + f);
process.exitCode = fail === 0 ? 0 : 1;
