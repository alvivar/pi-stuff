// Integration test for uppercase-pi (./index.ts).
//
// Loads the actual extension module, captures its before_provider_request
// handler via a fake ExtensionAPI, and runs synthetic payloads that mirror
// each supported provider shape. Asserts the transform rewrites standalone
// "pi" -> "PI" inside system-instruction fields only, leaves other fields
// alone, preserves cache_control and non-text blocks, is idempotent, and
// returns `undefined` when there's nothing to change.
//
// Placement: this file is a sibling of `index.ts` inside the extension
// directory. PI's loader (see loader.js::resolveExtensionEntries) only
// picks up `index.{ts,js}` or a `package.json` manifest from a directory
// extension, so this .mjs file is invisible to auto-discovery and will
// not be loaded as an extension itself.
//
// Run:
//   node C:/Users/andre/.pi/agent/extensions/uppercase-pi/test.mjs
// Requires: Node >= 22.6 for native TypeScript type stripping
// (the extension uses only `import type`, so runtime has no TS deps).

import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const extPath = path.join(here, "index.ts");
const mod = await import(pathToFileURL(extPath).href);

let handler;
const fakePi = {
  on(event, h) {
    if (event !== "before_provider_request") throw new Error(`unexpected event: ${event}`);
    handler = h;
  },
};
mod.default(fakePi);
if (!handler) throw new Error("extension did not register a before_provider_request handler");

// Helpers
let passed = 0;
let failed = 0;
const fails = [];

function run(payload) {
  // Runner contract: handler returns undefined to keep the payload,
  // or a replacement object. Mimic that: if undefined, pass the original.
  const out = handler({ type: "before_provider_request", payload }, {});
  return { result: out, effective: out === undefined ? payload : out };
}

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    fails.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? "\n        " + detail : ""}`);
  }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

// ---------------------------------------------------------------------------
section("1. Anthropic shape — payload.system[] with cache_control");
{
  const payload = {
    model: "claude-x",
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "You operate inside pi, a coding agent harness. pi rocks.", cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "hello pi" }],
  };
  const { result, effective } = run(payload);

  check("returns a replacement (not undefined)", result !== undefined);
  check("original payload not mutated", payload.system[1].text.includes("pi, a coding agent"));
  check("block[0] text unchanged (no standalone 'pi')", effective.system[0].text === payload.system[0].text);
  check("block[0] cache_control preserved (reference)", effective.system[0].cache_control === payload.system[0].cache_control);
  check("block[1] text rewritten to PI",
    effective.system[1].text === "You operate inside PI, a coding agent harness. PI rocks.",
    `got: ${JSON.stringify(effective.system[1].text)}`);
  check("block[1] cache_control preserved (reference)", effective.system[1].cache_control === payload.system[1].cache_control);
  check("block[1] type preserved", effective.system[1].type === "text");
  check("user message untouched (reference equal)", effective.messages === payload.messages);
  check("user message content untouched", effective.messages[0].content === "hello pi");

  // Idempotence: running the handler again on its output yields undefined / same
  const second = handler({ type: "before_provider_request", payload: effective }, {});
  check("idempotent (second call returns undefined)", second === undefined);
}

// ---------------------------------------------------------------------------
section("2. Amazon Bedrock shape — payload.system[] with { text } only");
{
  const payload = {
    system: [{ text: "pi says hi. PI stays PI." }],
    messages: [{ role: "user", content: "unchanged pi" }],
  };
  const { effective } = run(payload);
  check("bedrock block rewritten",
    effective.system[0].text === "PI says hi. PI stays PI.",
    `got: ${JSON.stringify(effective.system[0].text)}`);
  check("user message untouched", effective.messages[0].content === "unchanged pi");
}

// ---------------------------------------------------------------------------
section("3. Bedrock cache-point block without `text` left alone");
{
  const payload = {
    system: [
      { text: "pi and pi" },
      { cachePoint: { type: "default" } }, // no text field
    ],
  };
  const { effective } = run(payload);
  check("text block rewritten", effective.system[0].text === "PI and PI");
  check("cache-point block reference preserved", effective.system[1] === payload.system[1]);
}

// ---------------------------------------------------------------------------
section("4. OpenAI Codex Responses shape — payload.instructions (string)");
{
  const payload = {
    instructions: "You are inside pi. Use Pi carefully. PI is fine.",
    input: [{ role: "user", content: "hello pi" }],
  };
  const { effective } = run(payload);
  check("instructions rewritten",
    effective.instructions === "You are inside PI. Use PI carefully. PI is fine.",
    `got: ${JSON.stringify(effective.instructions)}`);
  check("user input item untouched", effective.input[0].content === "hello pi");
}

// ---------------------------------------------------------------------------
section("5. Google shape — payload.systemInstruction as string");
{
  const payload = { systemInstruction: "pi is PI" };
  const { effective } = run(payload);
  check("string systemInstruction rewritten", effective.systemInstruction === "PI is PI");
}

// ---------------------------------------------------------------------------
section("6. Google shape — payload.systemInstruction as { parts:[{text}] }");
{
  const payload = {
    systemInstruction: {
      role: "system",
      parts: [{ text: "use pi." }, { text: "nothing here." }, { inlineData: {} }],
    },
  };
  const { effective } = run(payload);
  check("parts[0].text rewritten", effective.systemInstruction.parts[0].text === "use PI.");
  check("parts[1].text untouched (no match)", effective.systemInstruction.parts[1].text === "nothing here.");
  check("parts[2] non-text preserved (reference)", effective.systemInstruction.parts[2] === payload.systemInstruction.parts[2]);
  check("systemInstruction.role preserved", effective.systemInstruction.role === "system");
}

// ---------------------------------------------------------------------------
section("7. OpenAI Completions / Mistral shape — payload.messages[]");
{
  const payload = {
    messages: [
      { role: "system", content: "You are pi." },
      { role: "user", content: "hello pi" },
      { role: "assistant", content: "hi there pi" },
      { role: "tool", content: "pi output", tool_call_id: "x" },
      { role: "developer", content: "developer note: pi rules" },
    ],
  };
  const { effective } = run(payload);
  check("system role content rewritten",
    effective.messages[0].content === "You are PI.",
    `got: ${JSON.stringify(effective.messages[0].content)}`);
  check("user message untouched (reference)", effective.messages[1] === payload.messages[1]);
  check("assistant message untouched (reference)", effective.messages[2] === payload.messages[2]);
  check("tool message untouched (reference)", effective.messages[3] === payload.messages[3]);
  check("developer role content rewritten",
    effective.messages[4].content === "developer note: PI rules",
    `got: ${JSON.stringify(effective.messages[4].content)}`);
}

// ---------------------------------------------------------------------------
section("8. OpenAI Responses / Azure shape — payload.input[] with system entry");
{
  const payload = {
    input: [
      { role: "system", content: "You operate inside pi." },
      { role: "user", content: [{ type: "input_text", text: "hello pi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hi pi" }] },
    ],
  };
  const { effective } = run(payload);
  check("input[0] system content rewritten",
    effective.input[0].content === "You operate inside PI.");
  check("input[1] user untouched (reference)", effective.input[1] === payload.input[1]);
  check("input[2] assistant untouched (reference)", effective.input[2] === payload.input[2]);
}

// ---------------------------------------------------------------------------
section("9. Chat-style array content with { type:'text', text }");
{
  const payload = {
    messages: [
      { role: "system", content: [
        { type: "text", text: "pi rules" },
        { type: "text", text: "no match here" },
        { type: "image", url: "x" },
      ] },
    ],
  };
  const { effective } = run(payload);
  check("content[0].text rewritten", effective.messages[0].content[0].text === "PI rules");
  check("content[1] untouched (reference)", effective.messages[0].content[1] === payload.messages[0].content[1]);
  check("content[2] non-text preserved (reference)", effective.messages[0].content[2] === payload.messages[0].content[2]);
}

// ---------------------------------------------------------------------------
section("10. Code-span preservation");
{
  const payload = {
    system: [{ text: "Run `pi install` to add pi. ```bash\npi install foo\n``` done." }],
  };
  const { effective } = run(payload);
  // Prose "pi" outside code spans -> PI. Inside backticks/fences unchanged.
  const expected = "Run `pi install` to add PI. ```bash\npi install foo\n``` done.";
  check("code spans preserved, prose uppercased",
    effective.system[0].text === expected,
    `got: ${JSON.stringify(effective.system[0].text)}`);
}

// ---------------------------------------------------------------------------
section("11. Identifier-like contexts skipped");
{
  const payload = {
    system: [{ text: "Install pi-coding-agent into .pi/extensions. api, _pi, pi.on stay. But pi alone becomes PI." }],
  };
  const { effective } = run(payload);
  const t = effective.system[0].text;
  check("pi-coding-agent preserved", t.includes("pi-coding-agent"));
  check(".pi/extensions preserved", t.includes(".pi/extensions"));
  check("api preserved", /\bapi\b/.test(t));
  check("_pi preserved", t.includes("_pi"));
  check("pi.on preserved", t.includes("pi.on"));
  check("standalone 'pi alone' uppercased", /\bPI alone\b/.test(t));
}

// ---------------------------------------------------------------------------
section("12. No-op fast path: handler returns undefined when nothing changes");
{
  // All PI already, no lowercase pi anywhere.
  const payload = {
    system: [{ type: "text", text: "PI is PI." }],
    instructions: "Nothing to change.",
    systemInstruction: "PI only.",
    messages: [{ role: "system", content: "All uppercase PI." }],
    input: [{ role: "system", content: "All uppercase PI." }],
  };
  const result = handler({ type: "before_provider_request", payload }, {});
  check("returned undefined (no-op fast path)", result === undefined);
}

// ---------------------------------------------------------------------------
section("13. Non-object / empty payload tolerated");
{
  check("null payload -> undefined", handler({ type: "before_provider_request", payload: null }, {}) === undefined);
  check("string payload -> undefined", handler({ type: "before_provider_request", payload: "ignore" }, {}) === undefined);
  check("empty object -> undefined", handler({ type: "before_provider_request", payload: {} }, {}) === undefined);
}

// ---------------------------------------------------------------------------
section("14. Case-insensitive match: 'Pi' and 'PI' both collapse to 'PI'");
{
  const payload = { instructions: "Pi pi PI Pie piano" };
  const { effective } = run(payload);
  // "Pie" and "piano" must be preserved (word-boundary stops at the extra letters).
  check("mixed case collapsed",
    effective.instructions === "PI PI PI Pie piano",
    `got: ${JSON.stringify(effective.instructions)}`);
}

// ---------------------------------------------------------------------------
section("15. Sentence-final 'pi.' is uppercased (regression: regex fix)");
{
  const payload = {
    system: [{ text: "You operate inside pi. But pi.on stays. Use pi, then pi!" }],
  };
  const { effective } = run(payload);
  check("sentence-final 'pi.' uppercased",
    effective.system[0].text === "You operate inside PI. But pi.on stays. Use PI, then PI!",
    `got: ${JSON.stringify(effective.system[0].text)}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of fails) console.log(` - ${f.name}${f.detail ? ": " + f.detail : ""}`);
  process.exit(1);
}
