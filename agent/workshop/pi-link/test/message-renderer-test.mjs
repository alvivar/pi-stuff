#!/usr/bin/env node

// Behavior tests for the incoming-message renderer: collapsed messages keep the
// first six *visual* rows and gain a hint; expanded ones render exactly as before.
//
// The renderer registered by the real extension is captured and called directly.
// Pi's `Text` is stubbed with a controlled component whose `render(width)` returns
// width-dependent rows, which is what proves our seam: we slice rendered rows at
// the supplied width rather than splitting the raw string on newlines. The stub
// deliberately does not reimplement Pi's wrapping algorithm — how a paragraph
// breaks is Pi's business, and the checks below never assert on it. Where the real
// pi-tui is installed, a final block repeats the load-bearing claims against the
// genuine `Text` and reports whether it ran.
//
// The extension is booted with the link flag off, so no socket is dialled and no
// port is bound. The live mesh is untouched.
//
// Usage: node test/message-renderer-test.mjs
// Requires Node 22.18+ or 24+ (module.registerHooks and TypeScript type stripping).

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(join(HERE, "..", "index.ts")).href;

// A controlled stand-in for Pi's Text. Rows depend on the width it is rendered at,
// so a single long logical line becomes several rows exactly as it would on screen.
const TEXT_STUB = `
export class Text {
  constructor(text = "", paddingX = 1, paddingY = 1) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.renders = [];
    this.invalidated = 0;
  }
  setText(text) { this.text = text; }
  invalidate() { this.invalidated++; }
  render(width) {
    this.renders.push(width);
    if (this.text === "") return [];
    const rows = [];
    for (const line of this.text.split("\\n")) {
      for (let i = 0; i < Math.max(line.length, 1); i += width) {
        rows.push(line.slice(i, i + width));
      }
    }
    return rows;
  }
}
`;

const STUBS = {
  "@earendil-works/pi-coding-agent": `
    export const VERSION = "0.84.2";
    export const keyHint = (id, description) => \`<\${id}:\${description}>\`;
  `,
  "@earendil-works/pi-tui": TEXT_STUB,
  typebox: `export const Type = {
    Object: () => ({}), String: () => ({}), Optional: (s) => s,
  };`,
  ws: `
    export class WebSocket {}
    export class WebSocketServer {}
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

const { Text } = await import("@earendil-works/pi-tui");
const createExtension = (await import(INDEX_URL)).default;

// ── Harness ─────────────────────────────────────────────────────────────────

// `fg` marks its role so styling is observable without asserting on real ANSI.
const theme = { fg: (role, text) => `{${role}}${text}`, bold: (text) => text };

let renderer;
createExtension({
  registerFlag() {},
  getFlag: () => false, // never connects: no socket is dialled, no port is bound
  on() {},
  registerTool() {},
  registerCommand() {},
  registerMessageRenderer(type, fn) { if (type === "link") renderer = fn; },
  appendEntry() {},
  getSessionName: () => undefined,
  setSessionName() {},
  sendMessage() {},
});

const render = (content, { expanded = false, details, width = 40 } = {}) =>
  renderer({ content, details, customType: "link" }, { expanded, outputPad: 0 }, theme).render(width);

const component = (content, { expanded = false, details } = {}) =>
  renderer({ content, details, customType: "link" }, { expanded, outputPad: 0 }, theme);

const lines = (n, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n");

// The hint may wrap, so it is matched against the joined rows: a row boundary can
// fall anywhere inside the phrase, exactly as it would on a narrow screen.
const hasHint = (rows) => rows.join("").includes("more lines");
const hidden = (rows) => Number(rows.join("").match(/\((\d+) more lines/)?.[1]);

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) { pass++; process.stdout.write("."); return; }
  fail++;
  failures.push(`${label}${detail ? `\n  ${detail}` : ""}`);
  process.stdout.write("F");
}

check("renderer: the extension registers a renderer for the link type", typeof renderer === "function");

// ── 1. Expanded renders exactly what it always did ──────────────────────────

{
  const long = lines(30);
  const rows = render(long, { expanded: true });
  const expected = new Text(
    `{accent}⚡ [link] ` + `{text}${long}`,
    0,
    0,
  ).render(40);
  check("1: expanded output equals the plain full-content Text",
    JSON.stringify(rows) === JSON.stringify(expected),
    `got ${rows.length} rows, expected ${expected.length}`);
  check("1: expanded shows every row, no hint",
    rows.length === 30 && !hasHint(rows));
}

{
  // A batched delivery is one message whose content carries several blocks.
  const batch = `\n\nFrom "a":\nfirst\n\nFrom "b":\nsecond`;
  const rows = render(batch, { expanded: true });
  const expected = new Text(`{accent}⚡ [link] ` + `{text}${batch}`, 0, 0).render(40);
  check("1: expanded batched delivery is unchanged",
    JSON.stringify(rows) === JSON.stringify(expected));
}

{
  // A historical message restored from a session: same path, no new data needed.
  const rows = render("restored", { expanded: true, details: { from: "sol" } });
  check("1: expanded historical message keeps details.from attribution",
    rows.join("").includes("[sol]"), rows.join("|"));
}

// ── 2. The six-row budget and its boundaries ────────────────────────────────

{
  const rows = render(lines(3));
  check("2: three rows render whole", rows.length === 3);
  check("2: three rows carry no hint", !hasHint(rows), rows.join("|"));
}

{
  const rows = render(lines(6));
  check("2: exactly six rows render whole", rows.length === 6, `got ${rows.length}`);
  check("2: exactly six rows carry no hint", !hasHint(rows), rows.join("|"));
}

{
  const rows = render(lines(7));
  // The budget covers content only: the hint itself may occupy more than one row
  // at a narrow width, so the assertion is on the content prefix, not the total.
  check("2: seven rows keep exactly six content rows",
    rows.slice(0, 6).join("|").includes("line6") && !rows.slice(0, 6).join("|").includes("line7"),
    rows.slice(0, 6).join("|"));
  check("2: everything after the sixth row is hint",
    rows.slice(6).length >= 1 && rows.slice(6).every((r) => !r.includes("line7")),
    rows.slice(6).join("|"));
  check("2: seven rows report one hidden row", hidden(rows) === 1, rows.join("|"));
}

// ── 3. Hidden count and the keybinding hint ─────────────────────────────────

{
  const rows = render(lines(30));
  check("3: thirty rows keep six", rows.slice(0, 6).length === 6 && rows[5].includes("line6"));
  check("3: the hint reports the exact hidden count", hidden(rows) === 24, rows.join("|"));
  check("3: the hint resolves the binding through keyHint",
    rows.join("").includes("<app.tools.expand:to expand>"), rows.join("|"));
  check("3: the hint is dimmed, not plain", rows.join("").includes("{muted}... ("), rows.join("|"));
}

// ── 4. Width changes are respected by the same component ────────────────────

{
  // One logical line, no newlines at all: raw-line counting would call this 1 row.
  const single = "x".repeat(2000);
  const wide = render(single, { width: 100 });
  const narrow = render(single, { width: 20 });
  check("4: a long single line is collapsed, not counted as one raw line",
    hasHint(wide), `${wide.length} rows`);
  check("4: a narrower width hides more rows",
    hidden(narrow) > hidden(wide), `narrow=${hidden(narrow)} wide=${hidden(wide)}`);

  // The same component instance, queried twice: the second answer must be current.
  const c = component(single);
  const first = c.render(100);
  const second = c.render(20);
  check("4: the same component re-renders for a new width",
    JSON.stringify(first) !== JSON.stringify(second));
  check("4: each render reports the count for the width it was asked about",
    JSON.stringify(second) === JSON.stringify(narrow), second.join("|"));
  check("4: re-rendering at the original width restores the original answer",
    JSON.stringify(c.render(100)) === JSON.stringify(first));
}

// ── 5. Invalidation and degenerate input ────────────────────────────────────

{
  const c = component(lines(30));
  c.render(40); // creates the hint, so both children exist to be invalidated
  const before = Text.prototype.invalidate;
  let invalidated = 0;
  Text.prototype.invalidate = function patched() { invalidated++; return before.call(this); };
  c.invalidate();
  Text.prototype.invalidate = before;
  check("5: invalidate is forwarded to the content and the hint", invalidated === 2, `calls=${invalidated}`);
}

{
  const c = component(lines(3));
  check("5: invalidate is safe before the hint has ever been built",
    (() => { try { c.invalidate(); return true; } catch { return false; } })());
}

{
  const rows = render("");
  check("5: empty content renders the attribution row only", rows.length === 1, rows.join("|"));
  check("5: empty content carries no hint", !hasHint(rows));
}

{
  const rows = render("one line");
  check("5: a short message renders whole with no hint",
    rows.length === 1 && !hasHint(rows), rows.join("|"));
}

// ── 6. Attribution: absent, legacy, and collapsed ───────────────────────────

{
  const rows = render("hello");
  check("6: a message with no details falls back to the link label",
    rows.join("").includes("[link]"), rows.join("|"));
}

{
  const rows = render("hello", { details: {} });
  check("6: details without a from still falls back to the link label",
    rows.join("").includes("[link]"), rows.join("|"));
}

{
  const rows = render(lines(30), { details: { from: "opus@pi-link" } });
  check("6: a collapsed message keeps its attribution in the first row",
    rows[0].includes("[opus@pi-link]"), rows[0]);
}

// ── 7. The same claims against the real installed Text, when available ──────

const REAL_TUI = join(
  process.env.APPDATA ?? "",
  "npm", "node_modules", "@earendil-works", "pi-coding-agent",
  "node_modules", "@earendil-works", "pi-tui", "dist", "index.js",
);

if (existsSync(REAL_TUI)) {
  const { Text: RealText } = await import(pathToFileURL(REAL_TUI).href);
  // Rebuild the seam over the real Text: same shape as the renderer's own call.
  const build = (text) => new RealText(text, 0, 0);

  const six = build(lines(6)).render(40);
  const seven = build(lines(7)).render(40);
  check("7: real Text agrees that six lines are six visual rows", six.length === 6, `got ${six.length}`);
  check("7: real Text agrees that seven lines are seven visual rows", seven.length === 7, `got ${seven.length}`);

  const wrapped = build("x".repeat(2000)).render(40);
  check("7: real Text wraps one long logical line into many visual rows",
    wrapped.length > 6, `got ${wrapped.length}`);
  check("7: real Text yields more rows at a narrower width",
    build("x".repeat(2000)).render(20).length > wrapped.length);
  check("7: real Text rows never exceed the requested width",
    wrapped.every((r) => r.length <= 40 || r.replace(/\x1b\[[0-9;]*m/g, "").length <= 40));
  console.log("\n  (block 7 ran against the installed pi-tui)");
} else {
  console.log("\n  (block 7 SKIPPED: installed pi-tui not found — stub-only evidence)");
}

console.log(`\n\nPassed: ${pass}`);
console.log(`Failed: ${fail}`);
for (const f of failures) console.log("  - " + f);
process.exitCode = fail === 0 ? 0 : 1;
