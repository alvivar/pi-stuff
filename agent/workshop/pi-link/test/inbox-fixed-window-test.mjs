#!/usr/bin/env node

// Behavior tests for inbox batching: the first queued message opens a fixed
// window and later arrivals join it without moving its deadline.
//
// The real extension and the real inbox path are driven through a real client
// socket carrying real `chat` frames. Only the modules Pi supplies are stubbed,
// and `setTimeout`/`clearTimeout` are replaced by a controlled clock so the
// window is advanced exactly, with no wall-clock sleeps and no production seam.
// No port is bound and no socket is dialled, so the live mesh is untouched.
//
// Usage: node test/inbox-fixed-window-test.mjs
// Requires Node 22.18+ or 24+ (module.registerHooks and TypeScript type stripping).

import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const INDEX_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"),
).href;

// The values the extension ships with; asserted against, never redefined.
const FLUSH_DELAY_MS = 200;
const BATCH_MAX_ITEMS = 20;
const COMPACT_TIMEOUT_MS = 300_000;
const OLD_COMPACT_TIMEOUT_MS = 180_000; // the deadline these budgets replaced

// ── Stubs for the modules Pi provides ───────────────────────────────────────

// The hub owns an HTTP server so it can answer `GET /status`. Stubbed under both
// specifier spellings so no suite can ever bind a real port.
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
  "@earendil-works/pi-coding-agent": `export const VERSION = "0.84.2";
    export const keyHint = (id, description) => description;
    // app.tools.expand is bound here; the unbound fallback is exercised in the renderer suite.
    export const keyText = () => "ctrl+e";`,
  "node:http": HTTP_STUB,
  http: HTTP_STUB,
  "@earendil-works/pi-tui": `export class Text { constructor(text) { this.text = text; } }
    export class Box { addChild() {} }`,
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
      close() {
        if (this.closed) return;
        this.closed = true;
        this.readyState = 3;
        this.emit("close");
      }
    }
    export class WebSocketServer extends EventEmitter {
      constructor(options) { super(); this.options = options; this.closed = false; servers.push(this); }
      close() { if (this.closed) return; this.closed = true; this.emit("close"); }
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

// ── Controlled clock ────────────────────────────────────────────────────────
// Installed before the extension runs, so every timer it arms is ours to fire.
// `setImmediate` is untouched and is what drains microtasks between callbacks.

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pending = new Map(); // id → { at, fn }
let clockNow = 0;
let nextTimerId = 0;

globalThis.setTimeout = (fn, ms = 0) => {
  const id = ++nextTimerId;
  pending.set(id, { at: clockNow + ms, fn });
  return id;
};
globalThis.clearTimeout = (id) => {
  pending.delete(id);
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Runs every callback due within `ms`, in deadline then arm order. */
async function advance(ms) {
  const target = clockNow + ms;
  for (;;) {
    const due = [...pending.entries()]
      .filter(([, timer]) => timer.at <= target)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    if (due.length === 0) break;
    const [id, timer] = due[0];
    pending.delete(id);
    clockNow = timer.at;
    timer.fn();
    await settle();
  }
  clockNow = target;
  await settle();
}

const wsStub = await import("ws");
const createExtension = (await import(INDEX_URL)).default;

// ── Harness ─────────────────────────────────────────────────────────────────

const booted = [];

function boot() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const notes = [];
  const delivered = [];

  const api = {
    registerFlag() {},
    getFlag: (name) => name === "link",
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, options) { commands.set(name, options); },
    registerMessageRenderer() {},
    appendEntry() {},
    getSessionName: () => undefined,
    setSessionName() {},
    sendMessage(message, options) { delivered.push({ message, options }); },
  };
  const ctx = {
    cwd: "C:/probe",
    ui: {
      theme: { fg: (_role, text) => text, bold: (text) => text },
      notify: (message) => notes.push(message),
      setStatus() {},
    },
    sessionManager: { getEntries: () => [] },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    compact() {},
  };

  const socketBase = wsStub.sockets.length;
  createExtension(api);

  const t = {
    notes,
    delivered,
    emit: async (event, payload = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
    // The registered tool, invoked exactly as Pi invokes it.
    tool: (name, params = {}, signal) => tools.get(name).execute("probe", params, signal),
    cmd: (name, args = "") => commands.get(name).handler(args, ctx),
    sockets: () => wsStub.sockets.slice(socketBase),
  };
  booted.push(t);
  return t;
}

/** Boots one terminal and establishes it as a client, ready to receive chats. */
async function establishedClient() {
  const t = boot();
  await t.emit("session_start", { reason: "startup" });
  await advance(0); // fire the deferred startup connect
  const socket = t.sockets()[0];
  socket.emit("open");
  await settle();
  t.receive = (frame) => socket.emit("message", Buffer.from(JSON.stringify(frame)));
  t.chat = (from, content) => t.receive({ type: "chat", from, to: "me", content });
  t.socket = socket;
  return t;
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

// Tolerant of a missing delivery, so a regression reports a failed assertion
// instead of throwing out of the suite.
// The gate's own observable: `compacting` has precedence over every other status
// a terminal derives, so the last status it published names the gate's state.
const gateStatus = (t) =>
  [...t.socket.sent].reverse().find((f) => f.type === "status_update")?.status?.kind;

const blocks = (delivery) => (delivery?.message?.content ?? "").split("\n\n").slice(1);
const senders = (delivery) => blocks(delivery).map((b) => b.match(/^From "([^"]+)":/)?.[1]);
const bodies = (delivery) => blocks(delivery).map((b) => b.split("\n").slice(1).join("\n"));

// ── 1. The first message owns the deadline ──────────────────────────────────

{
  const t = await establishedClient();
  const opened = clockNow; // the clock is shared, so every claim below is relative
  t.chat("a", "one"); // +0 opens the window
  await advance(60);
  t.chat("b", "two"); // +60 joins it
  await advance(60);
  t.chat("c", "three"); // +120 joins it
  await advance(60);
  t.chat("d", "four"); // +180 joins it
  check("1: nothing is delivered before the first message's deadline",
    t.delivered.length === 0 && clockNow - opened === 180,
    `delivered=${t.delivered.length} elapsed=${clockNow - opened}`);

  await advance(FLUSH_DELAY_MS - 180); // reach exactly +200
  check("1: the window fires 200ms after the FIRST message, not the last",
    t.delivered.length === 1 && clockNow - opened === FLUSH_DELAY_MS,
    `delivered=${t.delivered.length} elapsed=${clockNow - opened}`);
  const [first] = t.delivered;
  check("1: every message that joined the window is in that one batch",
    senders(first).join(",") === "a,b,c,d" && bodies(first).join(",") === "one,two,three,four",
    JSON.stringify(first?.message?.content ?? null));

  // Sustained sub-200ms arrivals keep being delivered window by window; under a
  // trailing-edge rearm this stream would never reach a deadline at all.
  t.chat("e", "five"); // t=200 opens the next window
  await advance(60);
  t.chat("f", "six");
  await advance(60);
  t.chat("g", "seven");
  await advance(80); // +400
  check("1: a sustained stream still delivers once per window",
    t.delivered.length === 2 && clockNow - opened === 400,
    `delivered=${t.delivered.length} elapsed=${clockNow - opened}`);
  check("1: the second window carries exactly its own arrivals in order",
    senders(t.delivered[1]).join(",") === "e,f,g",
    JSON.stringify(t.delivered[1]?.message?.content ?? null));
}

// ── 2. Batch shape, labels, order and delivery options ──────────────────────

{
  const t = await establishedClient();
  t.chat("orchestrator", "task one");
  t.chat("worker", "line one\nline two");
  await advance(FLUSH_DELAY_MS);
  check("2: exactly one sendMessage call per window", t.delivered.length === 1);
  const delivery = t.delivered[0] ?? { message: {}, options: {} };
  check("2: delivery still triggers a turn", delivery.options?.triggerTurn === true,
    JSON.stringify(delivery.options));
  check("2: header counts the batch",
    (delivery.message.content ?? "").startsWith("[Link: 2 message(s) received]"),
    JSON.stringify((delivery.message.content ?? "").slice(0, 40)));
  check("2: custom type and details are unchanged",
    delivery.message.customType === "link" && delivery.message.display === true &&
      delivery.message.details?.batched === true && delivery.message.details?.count === 2,
    JSON.stringify(delivery.message.details));
  check("2: senders are labelled in arrival order",
    senders(delivery).join(",") === "orchestrator,worker", JSON.stringify(senders(delivery)));
  check("2: multi-line content survives intact",
    bodies(delivery)[1] === "line one\nline two", JSON.stringify(bodies(delivery)));
}

// ── 3. Capped drain: the overflow goes out in the next window ───────────────

{
  const t = await establishedClient();
  const opened = clockNow;
  const total = BATCH_MAX_ITEMS + 5;
  for (let i = 1; i <= total; i++) {
    t.chat(`s${i}`, `m${i}`);
    await advance(1); // all inside the first window
  }
  check("3: the whole burst is still queued before the deadline",
    t.delivered.length === 0 && clockNow - opened === total,
    `delivered=${t.delivered.length} elapsed=${clockNow - opened}`);

  await advance(FLUSH_DELAY_MS - total);
  check("3: the first batch is capped at BATCH_MAX_ITEMS",
    t.delivered.length === 1 && blocks(t.delivered[0]).length === BATCH_MAX_ITEMS,
    `deliveries=${t.delivered.length} items=${blocks(t.delivered[0]).length}`);

  await advance(FLUSH_DELAY_MS);
  check("3: the remainder is delivered in the following window",
    t.delivered.length === 2 && blocks(t.delivered[1]).length === total - BATCH_MAX_ITEMS,
    `deliveries=${t.delivered.length}`);
  const seen = t.delivered.flatMap(bodies);
  check("3: every message is delivered exactly once, in order, none lost or duplicated",
    seen.length === total && seen.join(",") === Array.from({ length: total }, (_, i) => `m${i + 1}`).join(","),
    JSON.stringify(seen));

  await advance(FLUSH_DELAY_MS * 2);
  check("3: the drain stops once the inbox is empty", t.delivered.length === 2,
    `deliveries=${t.delivered.length}`);
}

// ── 4. Compaction holds the window, release delivers it ─────────────────────

{
  const t = await establishedClient();
  t.chat("peer", "held");
  await t.emit("session_before_compact", { reason: "manual" }); // raise the gate
  await advance(FLUSH_DELAY_MS);
  check("4: a window that fires while gated delivers nothing", t.delivered.length === 0,
    JSON.stringify(t.delivered));
  await advance(FLUSH_DELAY_MS * 5);
  check("4: and it does not poll while the gate stands", t.delivered.length === 0,
    `deliveries=${t.delivered.length}`);

  await t.emit("session_compact", { reason: "manual" }); // release
  check("4: release alone does not deliver synchronously", t.delivered.length === 0);
  await advance(FLUSH_DELAY_MS);
  check("4: the release schedules a window that delivers the held message",
    t.delivered.length === 1 && bodies(t.delivered[0]).join(",") === "held",
    JSON.stringify(t.delivered));

  t.chat("peer", "after");
  await advance(FLUSH_DELAY_MS);
  check("4: normal windows resume after the gate clears",
    t.delivered.length === 2 && bodies(t.delivered[1]).join(",") === "after",
    JSON.stringify(t.delivered.map((d) => bodies(d))));
}

// ── 5. The gate's fallback deadline is five minutes ───────────────────────

{
  // A manual compaction with no observable ending: the gate stands well past the
  // three-minute deadline it used to have, and only its own fallback clears it.
  // Held messages alone cannot date the release — delivery is a separate 200ms
  // window — so the gate itself is read from the status the terminal publishes,
  // which `compactionGated()` decides.
  const t = await establishedClient();
  t.chat("peer", "held");
  await t.emit("session_before_compact", { reason: "manual" });
  const raised = clockNow;
  check("5: raising the gate publishes `compacting`",
    gateStatus(t) === "compacting", JSON.stringify(t.socket.sent));

  await advance(OLD_COMPACT_TIMEOUT_MS);
  check("5: the gate still holds at the old three-minute deadline",
    gateStatus(t) === "compacting" && t.delivered.length === 0 &&
      clockNow - raised === OLD_COMPACT_TIMEOUT_MS,
    `status=${gateStatus(t)} delivered=${t.delivered.length} elapsed=${clockNow - raised}`);

  await advance(COMPACT_TIMEOUT_MS - OLD_COMPACT_TIMEOUT_MS - 1); // one tick short of 300s
  check("5: and one millisecond before the new one",
    gateStatus(t) === "compacting" && t.delivered.length === 0 &&
      clockNow - raised === COMPACT_TIMEOUT_MS - 1,
    `status=${gateStatus(t)} delivered=${t.delivered.length} elapsed=${clockNow - raised}`);

  await advance(1); // the fallback fires
  check("5: the fallback clears the gate exactly at five minutes, delivering nothing yet",
    gateStatus(t) === "idle" && t.delivered.length === 0,
    `status=${gateStatus(t)} delivered=${JSON.stringify(t.delivered)}`);
  await advance(FLUSH_DELAY_MS);
  check("5: the held message then goes out through a normal batching window",
    t.delivered.length === 1 && bodies(t.delivered[0]).join(",") === "held",
    JSON.stringify(t.delivered));
}

// ── 6. link_compact returns at once; every outcome arrives through the inbox ──

/** A client welcomed as "me" with `peers` visible, ready to request compactions. */
async function requester(peers = ["peer"]) {
  const t = await establishedClient();
  t.receive({ type: "welcome", name: "me", terminals: ["me", ...peers] });
  await settle();
  return t;
}

/** Sends a request and returns the tool result plus the frame that went out. */
async function request(t, to, signal) {
  const result = await t.tool("link_compact", { to }, signal);
  const frame = [...t.socket.sent].reverse().find((f) => f.type === "compact_request");
  return { result, frame, id: result.details?.id };
}

const respond = (t, id, from, ok, reason) =>
  t.receive({ type: "compact_response", id, from, to: "me", ok, reason });
const contents = (t) => t.delivered.map((d) => d.message.content);
const lineFor = (to, id, outcome) => `link_compact "${to}" [${id}]: ${outcome}`;

{
  // The call returns before anything is known, naming the ID the wire carries.
  const t = await requester();
  const before = clockNow;
  const { result, frame, id } = await request(t, "peer");
  check("6a: the call returns at once, without waiting on the target",
    clockNow === before && typeof id === "string" && frame?.id === id && frame.to === "peer",
    JSON.stringify({ result, frame }));
  check("6a: the result reports a sent request, not an accepted one",
    result.content[0].text ===
      `Compact request sent to "peer" [${id}]; the result will arrive as a link notification.` &&
      result.details.to === "peer" && result.details.error === undefined,
    JSON.stringify(result));

  // A success arrives as one sender-less line, in a normal batching window.
  respond(t, id, "peer", true);
  check("6b: the response alone delivers nothing synchronously", t.delivered.length === 0);
  await advance(FLUSH_DELAY_MS);
  check("6b: a success is one inbox line naming the target and the ID",
    t.delivered.length === 1 &&
      contents(t)[0] === `[Link: 1 message(s) received]\n\n${lineFor("peer", id, "compacted")}` &&
      t.delivered[0].options?.triggerTurn === true,
    JSON.stringify(t.delivered));

  // A duplicate or late response for an outcome already reported is ignored.
  respond(t, id, "peer", false, "busy");
  await advance(FLUSH_DELAY_MS);
  check("6b: a second response for a reported request is ignored", t.delivered.length === 1,
    JSON.stringify(contents(t)));
}

{
  // Declines and failures, including the hub's not_found, which comes from the hub.
  // Responses close together share one window with a chat, in arrival order.
  const t = await requester(["busy", "old", "small", "gone"]);
  const ids = {};
  for (const to of ["busy", "old", "small", "gone"]) ids[to] = (await request(t, to)).id;
  respond(t, ids.busy, "busy", false, "busy");
  respond(t, ids.old, "old", false, "unsupported");
  respond(t, ids.small, "small", false, "Nothing to compact (session too small)");
  t.chat("peer", "hello");
  respond(t, ids.gone, "hub", false, "not_found");
  await advance(FLUSH_DELAY_MS);
  const expected = [
    lineFor("busy", ids.busy, "not done: busy"),
    lineFor("old", ids.old, "not done: unsupported"),
    lineFor("small", ids.small, "not done: Nothing to compact (session too small)"),
    'From "peer":\nhello',
    lineFor("gone", ids.gone, "not done: not_found"),
  ];
  check("6c: each outcome names its requested target, never the responder",
    t.delivered.length === 1 &&
      contents(t)[0] === `[Link: 5 message(s) received]\n\n${expected.join("\n\n")}`,
    JSON.stringify(contents(t)));
  check("6c: the mixed batch keeps the chat as the only From block",
    senders(t.delivered[0]).join(",") === ",,,peer,", JSON.stringify(senders(t.delivered[0])));
  check("6c: the four IDs are distinct", new Set(Object.values(ids)).size === 4, JSON.stringify(ids));
}

{
  // A departed target can no longer answer; others are untouched.
  const t = await requester(["peer", "other"]);
  const { id } = await request(t, "peer");
  const { id: otherId } = await request(t, "other");
  t.receive({ type: "terminal_left", name: "peer", terminals: ["me", "other"] });
  await advance(FLUSH_DELAY_MS);
  check("6d: departure reports an unknown result, once",
    contents(t).join("|") ===
      `[Link: 1 message(s) received]\n\n${lineFor("peer", id, "left the link before answering; result unknown")}`,
    JSON.stringify(contents(t)));
  respond(t, otherId, "other", true);
  await advance(FLUSH_DELAY_MS);
  check("6d: another target's request still reports its own outcome",
    t.delivered.length === 2 && contents(t)[1].endsWith(lineFor("other", otherId, "compacted")),
    JSON.stringify(contents(t)));
}

{
  // The deadline only observes: five minutes with no answer is reported, and the
  // answer that comes after it is ignored.
  const t = await requester();
  const { id } = await request(t, "peer");
  const dispatched = clockNow;
  await advance(COMPACT_TIMEOUT_MS - 1);
  check("6e: nothing is reported one millisecond before the deadline",
    t.delivered.length === 0 && clockNow - dispatched === COMPACT_TIMEOUT_MS - 1,
    JSON.stringify(contents(t)));
  await advance(1 + FLUSH_DELAY_MS);
  check("6e: at five minutes the deadline is reported, saying the target may still compact",
    contents(t).join("|") ===
      `[Link: 1 message(s) received]\n\n${lineFor("peer", id, "no confirmation within 300s; the target may still be compacting")}`,
    JSON.stringify(contents(t)));
  respond(t, id, "peer", true);
  await advance(FLUSH_DELAY_MS);
  check("6e: a response after the deadline is ignored", t.delivered.length === 1,
    JSON.stringify(contents(t)));
}

{
  // The requester's own compaction gate holds an outcome like any message.
  const t = await requester();
  const { id } = await request(t, "peer");
  await t.emit("session_before_compact", { reason: "manual" });
  respond(t, id, "peer", true);
  await advance(FLUSH_DELAY_MS * 3);
  check("6f: an outcome is held while the requester is compaction-gated", t.delivered.length === 0);
  await t.emit("session_compact", { reason: "manual" });
  await advance(FLUSH_DELAY_MS);
  check("6f: and delivered once the gate clears",
    t.delivered.length === 1 && contents(t)[0].endsWith(lineFor("peer", id, "compacted")),
    JSON.stringify(contents(t)));
}

{
  // Losing the hub keeps tracking, so an answer can still arrive after reconnecting.
  const t = await requester();
  const { id } = await request(t, "peer");
  t.socket.close();
  await advance(5_000); // past the reconnect delay, jitter included
  const next = t.sockets()[1];
  next.emit("open");
  await settle();
  next.emit("message", Buffer.from(JSON.stringify({ type: "welcome", name: "me", terminals: ["me", "peer"] })));
  next.emit("message", Buffer.from(JSON.stringify({ type: "compact_response", id, from: "peer", to: "me", ok: true })));
  await advance(FLUSH_DELAY_MS);
  check("6g: a response after a reconnect still reports its outcome",
    t.delivered.length === 1 && contents(t)[0].endsWith(lineFor("peer", id, "compacted")),
    JSON.stringify(contents(t)));
}

{
  // An explicit disconnect ends tracking with one explicit notification per request.
  const t = await requester(["peer", "other"]);
  const { id } = await request(t, "peer");
  const { id: otherId } = await request(t, "other");
  await t.cmd("link-disconnect");
  await advance(FLUSH_DELAY_MS);
  const outcome = "link disconnected before an answer; result unknown, the target may still be compacting";
  check("6h: disconnect reports each pending request as unknown, in one delivery",
    contents(t).join("|") ===
      `[Link: 2 message(s) received]\n\n${lineFor("peer", id, outcome)}\n\n${lineFor("other", otherId, outcome)}`,
    JSON.stringify(contents(t)));
  await advance(COMPACT_TIMEOUT_MS);
  check("6h: and nothing else follows, not even the deadline", t.delivered.length === 1,
    JSON.stringify(contents(t)));
}

{
  // The hub is lost first, so requests are still tracked while nothing is
  // established; an explicit disconnect then must end them the same way.
  const t = await requester(["peer", "other"]);
  const { id } = await request(t, "peer");
  const { id: otherId } = await request(t, "other");
  t.socket.close();
  await settle();
  await t.cmd("link-disconnect");
  await advance(FLUSH_DELAY_MS);
  const outcome = "link disconnected before an answer; result unknown, the target may still be compacting";
  check("6h: after a hub loss, disconnect still reports each request once",
    contents(t).join("|") ===
      `[Link: 2 message(s) received]\n\n${lineFor("peer", id, outcome)}\n\n${lineFor("other", otherId, outcome)}`,
    JSON.stringify(contents(t)));
  const reported = contents(t).join("|");
  await advance(COMPACT_TIMEOUT_MS);
  check("6h: and neither a reconnect nor the deadline follows",
    contents(t).join("|") === reported && t.sockets().length === 1, JSON.stringify(contents(t)));
}

{
  // Local failures stay immediate and leave nothing tracked.
  const t = await requester();
  const aborted = new AbortController();
  aborted.abort();
  const sentBefore = t.socket.sent.length;
  const { result: abortedResult } = await request(t, "peer", aborted.signal);
  check("6i: an already-aborted call sends nothing and says so",
    abortedResult.details.error === "aborted" && t.socket.sent.length === sentBefore,
    JSON.stringify(abortedResult));

  // Aborting after the request went out changes nothing: the outcome still arrives.
  const later = new AbortController();
  const { id } = await request(t, "peer", later.signal);
  later.abort();
  respond(t, id, "peer", true);
  await advance(FLUSH_DELAY_MS);
  check("6i: an abort after sending does not cancel the outcome",
    t.delivered.length === 1 && contents(t)[0].endsWith(lineFor("peer", id, "compacted")),
    JSON.stringify(contents(t)));

  t.socket.readyState = 3; // the hub connection is not open: the request is not handed on
  const failed = await t.tool("link_compact", { to: "peer" });
  t.socket.readyState = 1;
  check("6i: a request that cannot be sent fails in the result",
    failed.details.error === "not_delivered" && failed.details.id === undefined,
    JSON.stringify(failed));
  await advance(COMPACT_TIMEOUT_MS + FLUSH_DELAY_MS);
  check("6i: and leaves nothing tracked to report later", t.delivered.length === 1,
    JSON.stringify(contents(t)));
}

{
  // Shutdown drops outcomes with the inbox: no turn is started in a dead context.
  const t = await requester();
  await request(t, "peer");
  await t.emit("session_shutdown", { reason: "quit" });
  await advance(COMPACT_TIMEOUT_MS + FLUSH_DELAY_MS);
  check("6j: shutdown with a pending request delivers nothing", t.delivered.length === 0,
    JSON.stringify(contents(t)));
}

// ── 7. Shutdown cancels the pending window and drops the queue ──────────────

{
  const t = await establishedClient();
  t.chat("peer", "never delivered");
  await advance(60); // window armed, deadline not reached
  await t.emit("session_shutdown", { reason: "quit" });
  check("7: shutdown leaves no timer of ours pending", pending.size === 0,
    `pending=${JSON.stringify([...pending.values()].map((timer) => timer.at))}`);
  await advance(FLUSH_DELAY_MS * 10);
  check("7: nothing is delivered after shutdown", t.delivered.length === 0,
    JSON.stringify(t.delivered));
}

// ── Teardown: every instance releases its timers and transports ─────────────

for (const t of booted) await t.emit("session_shutdown", { reason: "quit" });
await advance(0);

check("teardown: no controlled timer is left pending", pending.size === 0,
  `pending=${JSON.stringify([...pending.values()].map((timer) => timer.at))}`);
check("teardown: every socket is closed",
  wsStub.sockets.every((socket) => socket.closed),
  `open=${wsStub.sockets.filter((s) => !s.closed).length}`);

globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;

console.log(`\n\nPassed: ${pass}`);
console.log(`Failed: ${fail}`);
for (const f of failures) console.log("  - " + f);
process.exitCode = fail === 0 ? 0 : 1;
