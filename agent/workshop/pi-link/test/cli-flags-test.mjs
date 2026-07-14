#!/usr/bin/env node

// Automated tests for the pi-link CLI flag parser.
// Runs against bin/pi-link.mjs. Cases that would spawn pi use a stubbed pi
// shim on PATH that records argv + PI_LINK_NAME to a file and exits 0.
//
// Usage:
//   node test/cli-flags-test.mjs           # run all
//   node test/cli-flags-test.mjs <filter>  # only cases whose label includes <filter>

import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync } from "fs";
import { tmpdir, platform } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "bin", "pi-link.mjs");
const filter = process.argv[2] || "";
const isWin = platform() === "win32";

// ── Stub pi on PATH ─────────────────────────────────────────────────────────
// Records argv + PI_LINK_NAME to a file. On Windows the wrapper spawns via
// `cmd.exe /d /c pi ...` so we need a `.cmd` shim; elsewhere a shebanged
// Node script is enough.

const stubDir = mkdtempSync(join(tmpdir(), "pi-link-test-"));
const stubRecordFile = join(stubDir, "record.json");

const stubBody =
  `import { writeFileSync } from "fs";\n` +
  `writeFileSync(${JSON.stringify(stubRecordFile)}, JSON.stringify({\n` +
  `  argv: process.argv.slice(2),\n` +
  `  piLinkName: process.env.PI_LINK_NAME ?? null,\n` +
  `}));\n` +
  `process.exit(0);\n`;

if (isWin) {
  const stubJs = join(stubDir, "pi-stub.mjs");
  writeFileSync(stubJs, stubBody);
  writeFileSync(join(stubDir, "pi.cmd"), `@echo off\r\nnode "${stubJs}" %*\r\n`);
} else {
  const piShim = join(stubDir, "pi");
  writeFileSync(piShim, `#!/usr/bin/env node\n${stubBody}`);
  chmodSync(piShim, 0o755);
}

// Isolated agent dir so we don't touch real sessions.
const agentDir = join(stubDir, "agent");
mkdirSync(join(agentDir, "sessions"), { recursive: true });

const baseEnv = {
  ...process.env,
  PATH: stubDir + (isWin ? ";" : ":") + process.env.PATH,
  PI_CODING_AGENT_DIR: agentDir,
  NO_COLOR: "1",
};
delete baseEnv.PI_LINK_NAME; // never leak the test runner's own env into spawns

// ── Test harness ────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures = [];

function clearRecord() {
  if (existsSync(stubRecordFile)) rmSync(stubRecordFile);
}

function readRecord() {
  if (!existsSync(stubRecordFile)) return null;
  return JSON.parse(readFileSync(stubRecordFile, "utf-8"));
}

function run(args) {
  clearRecord();
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: baseEnv,
    cwd: stubDir,
    timeout: 10000,
  });
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    record: readRecord(),
  };
}

// Single place the filter is applied: caller passes a thunk that runs the spawn
// and returns [ok, detail]. Skipped cases never spawn.
function runCase(label, body) {
  if (filter && !label.toLowerCase().includes(filter.toLowerCase())) return;
  const [ok, detail] = body();
  if (ok) {
    pass++;
    process.stdout.write(".");
  } else {
    fail++;
    failures.push(`${label}\n  ${detail}`);
    process.stdout.write("F");
  }
}

// Asserts exit code, and (if given) that `substring` appears in stdout+stderr.
function expectExit(label, args, code, substring) {
  runCase(label, () => {
    const r = run(args);
    const combined = r.stdout + r.stderr;
    const ok = r.code === code && (substring === undefined || combined.includes(substring));
    return [
      ok,
      `args: ${JSON.stringify(args)}\n  expected: exit ${code}${substring ? `, output~"${substring}"` : ""}\n  actual:   exit ${r.code}, stdout: ${JSON.stringify(r.stdout.slice(0, 200))}, stderr: ${JSON.stringify(r.stderr.slice(0, 200))}`,
    ];
  });
}

// Asserts pi was spawned with exactly `argv` (order + length both checked) and
// PI_LINK_NAME equals `piLinkName`.
function expectSpawn(label, args, argv, piLinkName) {
  runCase(label, () => {
    const r = run(args);
    const rec = r.record;
    const argvOk = rec !== null && JSON.stringify(rec.argv) === JSON.stringify(argv);
    const nameOk = rec !== null && rec.piLinkName === piLinkName;
    const ok = r.code === 0 && argvOk && nameOk;
    return [
      ok,
      `args: ${JSON.stringify(args)}\n  expected: argv=${JSON.stringify(argv)}, PI_LINK_NAME=${JSON.stringify(piLinkName)}\n  actual:   exit ${r.code}, record=${JSON.stringify(rec)}, stderr=${JSON.stringify(r.stderr.slice(0, 200))}`,
    ];
  });
}

// ── Cases ───────────────────────────────────────────────────────────────────

console.log(`Running pi-link CLI flag tests`);
console.log(`  CLI: ${CLI}`);
console.log(`  stub dir: ${stubDir}\n`);

// A. Canonical forms
expectExit("A1: --list empty cwd", ["--list"], 0, "No pi-link sessions");
expectExit("A2: --list -g", ["--list", "-g"], 0, "No pi-link sessions");
expectExit("A4: --resolve missing → exit 2", ["--resolve", "nope"], 2, "No session named");
expectExit("A6: --resolve=missing → exit 2", ["--resolve=nope"], 2, "No session named");
expectExit("A7: --resolve missing -g → exit 2", ["--resolve", "nope", "-g"], 2);

// B. Removed subcommands
expectExit("B8: list removed", ["list"], 1, "was removed");
expectExit("B9: resolve removed", ["resolve", "nope"], 1, "was removed");
expectExit("B10: list -g removed", ["list", "-g"], 1, "was removed");
expectExit("B11: resolve --global nope removed", ["resolve", "--global", "nope"], 1, "was removed");

// C. Orphan-positional rejection (launcher mode)
expectExit("C12: foo extra → unexpected", ["foo", "extra"], 1, "Unexpected argument after session name");
expectExit("C13: resolv foo (typo) → unexpected", ["resolv", "foo"], 1, "Unexpected argument after session name");
expectSpawn("C14: foo --model opus passthrough", ["foo", "--model", "opus"], ["--link", "--model", "opus"], "foo");
expectSpawn("C15: foo --model=opus passthrough", ["foo", "--model=opus"], ["--link", "--model=opus"], "foo");
expectExit("C16: foo --model=opus extra → reject (=-form is self-contained)", ["foo", "--model=opus", "extra"], 1, "Unexpected argument after session name: extra");
expectExit("C17: foo --model opus extra → reject (opus consumed as value)", ["foo", "--model", "opus", "extra"], 1, "Unexpected argument after session name: extra");
expectSpawn("C18: foo -- extra extra2 passthrough", ["foo", "--", "extra", "extra2"], ["--link", "extra", "extra2"], "foo");

// D. Mode-selecting validation
expectExit("D19: --list foo → does not accept", ["--list", "foo"], 1, "--list does not accept argument");
expectExit("D20: --resolve (no value)", ["--resolve"], 1, "requires a name argument");
expectExit("D21: --resolve --global", ["--resolve", "--global"], 1, "requires a name argument");
expectExit("D22: --resolve foo bar", ["--resolve", "foo", "bar"], 1, "accepts exactly one name");
expectExit("D23: --list --resolve foo", ["--list", "--resolve", "foo"], 1, "cannot combine");
expectExit("D24: --resolve=\"\"", ["--resolve="], 1, "requires");
expectExit("D25: foo --list", ["foo", "--list"], 1, "cannot combine");
expectExit("D26: --resolve foo --resolve bar", ["--resolve", "foo", "--resolve", "bar"], 1, "specified more than once");
expectExit("D27: --resolve=foo --resolve=bar", ["--resolve=foo", "--resolve=bar"], 1, "specified more than once");
expectExit("D28: --global --resolve missing", ["--global", "--resolve", "nope"], 2, "No session named");
expectExit("D29: foo --help", ["foo", "--help"], 1, "cannot combine");

// E. Help / unknown / managed-flag rejection
expectExit("E30a: --help", ["--help"], 0, "Usage:");
expectExit("E30b: -h", ["-h"], 0, "Usage:");
expectExit("E31: --help foo", ["--help", "foo"], 1, "--help does not accept arguments");
expectExit("E32: no args", [], 0, "Usage:");
expectExit("E33: --unknown", ["--unknown"], 1, "Unknown argument");
expectExit("E34: --all unknown", ["--all"], 1, "Unknown argument");
expectExit("E35: --session foo.jsonl", ["--session", "foo.jsonl"], 1, "managed by pi-link");
expectExit("E36: foo --session bar.jsonl", ["foo", "--session", "bar.jsonl"], 1, "managed by pi-link");
expectExit("E37: foo --link-name bar", ["foo", "--link-name", "bar"], 1, "--link-name is not accepted");

// G. Wrapper-vs-pi flag boundaries (added per review)
expectSpawn("G38: foo --global is consumed by wrapper (not forwarded)", ["foo", "--global"], ["--link"], "foo");
expectSpawn("G39: foo -- --global escapes through to pi", ["foo", "--", "--global"], ["--link", "--global"], "foo");
expectSpawn("G40: foo (no extra args) passes only --link", ["foo"], ["--link"], "foo");
expectSpawn("G41: PI_LINK_NAME equals the resolved name (whitespace normalized)", ["  foo  "], ["--link"], "foo");
expectSpawn("G42: foo -a passes through to pi", ["foo", "-a"], ["--link", "-a"], "foo");

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n\nPassed: ${pass}`);
console.log(`Failed: ${fail}`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
}

try { rmSync(stubDir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
