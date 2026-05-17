#!/usr/bin/env node

// Automated tests for the pi-link CLI flag parser.
// Runs against bin/pi-link.mjs. Cases that would spawn pi use a stubbed pi
// shim on PATH that records its argv to a file and exits 0.
//
// Usage:
//   node test/cli-flags-test.mjs           # run all
//   node test/cli-flags-test.mjs <filter>  # only cases whose label includes <filter>

import { spawnSync, spawn } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync } from "fs";
import { tmpdir, platform } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "bin", "pi-link.mjs");

const filter = process.argv[2] || "";
const isWin = platform() === "win32";

// ── pi stub ─────────────────────────────────────────────────────────────────
// We create a tmp dir with a `pi` (or `pi.cmd` on Windows) shim that writes
// argv to STUB_ARGV_FILE and exits 0. Tests that expect a launch read that file.

const stubDir = mkdtempSync(join(tmpdir(), "pi-link-test-"));
const stubArgvFile = join(stubDir, "argv.txt");

if (isWin) {
  // Use a tiny Node script for both platforms; on Windows wrap via a .cmd shim
  // so that PATH lookup finds it. The wrapper invokes via `cmd.exe /d /c pi ...`
  // on Windows so a .cmd file is the right shim type.
  const stubJs = join(stubDir, "pi-stub.mjs");
  writeFileSync(
    stubJs,
    `import { writeFileSync } from "fs";\nwriteFileSync(${JSON.stringify(stubArgvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(0);\n`,
  );
  writeFileSync(
    join(stubDir, "pi.cmd"),
    `@echo off\r\nnode "${stubJs}" %*\r\n`,
  );
} else {
  const stubJs = join(stubDir, "pi-stub.mjs");
  writeFileSync(
    stubJs,
    `#!/usr/bin/env node\nimport { writeFileSync } from "fs";\nwriteFileSync(${JSON.stringify(stubArgvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(0);\n`,
  );
  const piShim = join(stubDir, "pi");
  writeFileSync(piShim, `#!/usr/bin/env node\n${readFileSync(stubJs, "utf-8").replace(/^#![^\n]*\n/, "")}`);
  chmodSync(piShim, 0o755);
}

// ── Isolated agent dir so we don't touch real sessions ──────────────────────

const agentDir = join(stubDir, "agent");
mkdirSync(join(agentDir, "sessions"), { recursive: true });

const baseEnv = {
  ...process.env,
  PATH: stubDir + (isWin ? ";" : ":") + process.env.PATH,
  PI_CODING_AGENT_DIR: agentDir,
  // Avoid leaking the launcher into stub spawns:
  PI_LINK_NAME: undefined,
  NO_COLOR: "1",
};

// ── Test harness ────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures = [];

function clearStubArgv() {
  if (existsSync(stubArgvFile)) rmSync(stubArgvFile);
}

function readStubArgv() {
  if (!existsSync(stubArgvFile)) return null;
  return JSON.parse(readFileSync(stubArgvFile, "utf-8"));
}

function run(args, opts = {}) {
  clearStubArgv();
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...baseEnv, ...(opts.env || {}) },
    cwd: opts.cwd || stubDir,
    timeout: 10000,
  });
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    argv: readStubArgv(),
    signal: result.signal,
  };
}

function check(label, condition, detail) {
  if (filter && !label.toLowerCase().includes(filter.toLowerCase())) return;
  if (condition) {
    pass++;
    process.stdout.write(".");
  } else {
    fail++;
    failures.push(`${label}\n  ${detail}`);
    process.stdout.write("F");
  }
}

// substring may appear in either stdout or stderr (combined output check).
function expectExit(label, args, code, substring, opts) {
  if (filter && !label.toLowerCase().includes(filter.toLowerCase())) return;
  const r = run(args, opts);
  const combined = r.stdout + r.stderr;
  const ok = r.code === code && (substring === undefined || combined.includes(substring));
  if (ok) {
    pass++;
    process.stdout.write(".");
  } else {
    fail++;
    failures.push(
      `${label}\n  args: ${JSON.stringify(args)}\n  expected: exit ${code}${substring ? `, output~"${substring}"` : ""}\n  actual:   exit ${r.code}, stdout: ${JSON.stringify(r.stdout.slice(0, 200))}, stderr: ${JSON.stringify(r.stderr.slice(0, 200))}`,
    );
    process.stdout.write("F");
  }
}

function expectStub(label, args, expectedArgvSubseq, opts) {
  if (filter && !label.toLowerCase().includes(filter.toLowerCase())) return;
  const r = run(args, opts);
  const argv = r.argv;
  const hasAll = argv !== null && expectedArgvSubseq.every((t) => argv.includes(t));
  if (r.code === 0 && hasAll) {
    pass++;
    process.stdout.write(".");
  } else {
    fail++;
    failures.push(
      `${label}\n  args: ${JSON.stringify(args)}\n  expected stub argv to include: ${JSON.stringify(expectedArgvSubseq)}\n  actual:   exit ${r.code}, argv ${JSON.stringify(argv)}, stderr ${JSON.stringify(r.stderr.slice(0, 300))}`,
    );
    process.stdout.write("F");
  }
}

// ── Cases ───────────────────────────────────────────────────────────────────

console.log(`Running pi-link CLI flag tests`);
console.log(`  CLI: ${CLI}`);
console.log(`  stub dir: ${stubDir}`);
console.log(`  agent dir: ${agentDir}`);
console.log("");

// A. Canonical forms
expectExit("A1: --list empty cwd", ["--list"], 0, "No pi-link sessions");
expectExit("A2: --list -g", ["--list", "-g"], 0, "No pi-link sessions");
expectExit("A4: --resolve missing → exit 2", ["--resolve", "nope"], 2, "No session named");
expectExit("A6: --resolve=missing → exit 2", ["--resolve=nope"], 2, "No session named");
expectExit("A7: --resolve missing -g → exit 2", ["--resolve", "nope", "-g"], 2);

// B. Deprecation aliases
expectExit("B8: list (deprecated)", ["list"], 0, "deprecated");
expectExit("B9: resolve missing (deprecated)", ["resolve", "nope"], 2, "deprecated");
expectExit("B10: list -g (deprecated)", ["list", "-g"], 0, "deprecated");
expectExit("B11: resolve --global foo (lenient)", ["resolve", "--global", "nope"], 2, "deprecated");

// C. Orphan-positional rejection
expectExit("C12: foo extra → unexpected", ["foo", "extra"], 1, "Unexpected argument after session name");
expectExit("C13: resolv foo (typo) → unexpected", ["resolv", "foo"], 1, "Unexpected argument after session name");
expectStub("C14: foo --model opus passthrough", ["foo", "--model", "opus"], ["--model", "opus"]);
expectStub("C15: foo --model=opus passthrough", ["foo", "--model=opus"], ["--model=opus"]);
expectExit("C16: foo --model=opus extra → reject", ["foo", "--model=opus", "extra"], 1, "Unexpected argument after session name: extra");
expectExit("C17: foo --model opus extra → reject", ["foo", "--model", "opus", "extra"], 1, "Unexpected argument after session name: extra");
expectStub("C18: foo -- extra extra2 passthrough", ["foo", "--", "extra", "extra2"], ["extra", "extra2"]);

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
expectExit("E34: --all (renamed)", ["--all"], 1, "renamed");
expectExit("E35: --session foo.jsonl", ["--session", "foo.jsonl"], 1, "managed by pi-link");
expectExit("E36: foo --session bar.jsonl", ["foo", "--session", "bar.jsonl"], 1, "managed by pi-link");
expectExit("E37: foo --link-name bar", ["foo", "--link-name", "bar"], 1, "--link-name is not accepted");

// ── Report ──────────────────────────────────────────────────────────────────

console.log("");
console.log("");
console.log(`Passed: ${pass}`);
console.log(`Failed: ${fail}`);
if (failures.length) {
  console.log("");
  console.log("Failures:");
  for (const f of failures) console.log("  - " + f);
}

// Cleanup
try { rmSync(stubDir, { recursive: true, force: true }); } catch {}

process.exit(fail === 0 ? 0 : 1);
