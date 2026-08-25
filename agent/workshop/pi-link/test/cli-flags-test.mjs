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

function run(args, envOverrides, cwdOverride) {
  clearRecord();
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: envOverrides ? { ...baseEnv, ...envOverrides } : baseEnv,
    cwd: cwdOverride ?? stubDir,
    timeout: 10000,
  });
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    record: readRecord(),
  };
}

function writeSessionAt(filePath, entries) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return filePath;
}

function writeSession(relPath, entries) {
  return writeSessionAt(join(agentDir, "sessions", relPath), entries);
}

// Filler history, so a `link-name` placed after it is genuinely late in the file.
const history = (count) =>
  Array.from({ length: count }, (_, i) => ({
    type: "message",
    id: `m${i}`,
    message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `line ${i}` }] },
  }));

// The advice a local miss prints, and the claim it must never make.
const GLOBAL_ADVICE = "Use --global to search other cwds.";
const claimsForeignMatch = (output) => /match(es)? in other cwds/.test(output);

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

// H. Resolution semantics
runCase("H2: renamed link-name is last-wins", () => {
  const filePath = writeSession(join("h2-rename", "renamed.jsonl"), [
    { type: "session", cwd: stubDir, id: "h2-rename" },
    { type: "custom", customType: "link-name", data: { name: "rename-old" } },
    { type: "custom", customType: "link-name", data: { name: "rename-new" } },
  ]);
  const current = run(["--resolve", "rename-new"]);
  const historical = run(["--resolve", "rename-old"]);
  const ok =
    current.code === 0 &&
    current.stdout === filePath &&
    historical.code === 2;
  return [
    ok,
    `new: exit ${current.code}, stdout=${JSON.stringify(current.stdout)}; old: exit ${historical.code}, stderr=${JSON.stringify(historical.stderr)}`,
  ];
});

// A foreign session whose link-name sits after its history: a local scan must
// never see that name, and must not claim anything about other cwds.
const h5ForeignPath = writeSession(join("h5-elsewhere", "elsewhere.jsonl"), [
  { type: "session", cwd: join(stubDir, "other-cwd"), id: "h5-elsewhere" },
  ...history(6),
  { type: "custom", customType: "link-name", data: { name: "elsewhere" } },
  ...history(2),
]);

runCase("H5: local resolve ignores foreign names and advises --global", () => {
  const local = run(["--resolve", "elsewhere"]);
  const global = run(["--resolve", "elsewhere", "-g"]);
  const localOutput = local.stdout + local.stderr;
  const ok =
    local.code === 2 &&
    localOutput.includes('No session named "elsewhere" found in this cwd.') &&
    localOutput.includes(GLOBAL_ADVICE) &&
    !claimsForeignMatch(localOutput) &&
    global.code === 0 &&
    global.stdout === h5ForeignPath;
  return [
    ok,
    `local: exit ${local.code}, output=${JSON.stringify(localOutput)}; global: exit ${global.code}, stdout=${JSON.stringify(global.stdout)}`,
  ];
});

runCase("H5b: launcher starts a new session for a foreign-only name", () => {
  const r = run(["elsewhere"]);
  const output = r.stdout + r.stderr;
  const ok =
    r.code === 0 &&
    r.record !== null &&
    JSON.stringify(r.record.argv) === JSON.stringify(["--link"]) &&
    r.record.piLinkName === "elsewhere" &&
    output.includes('No "elsewhere" found in this cwd. ' + GLOBAL_ADVICE) &&
    output.includes("Starting new session.") &&
    !claimsForeignMatch(output);
  return [
    ok,
    `exit ${r.code}, record=${JSON.stringify(r.record)}, output=${JSON.stringify(output)}`,
  ];
});

runCase("H5c: custom flat sessionDir scopes locally and stays global-visible", () => {
  const flatDir = join(stubDir, "flat-sessions");
  const localPath = writeSessionAt(join(flatDir, "flat-local.jsonl"), [
    { type: "session", cwd: stubDir, id: "flat-local" },
    ...history(4),
    { type: "custom", customType: "link-name", data: { name: "flat-local" } },
  ]);
  const foreignPath = writeSessionAt(join(flatDir, "flat-foreign.jsonl"), [
    { type: "session", cwd: join(stubDir, "other-cwd"), id: "flat-foreign" },
    ...history(4),
    { type: "custom", customType: "link-name", data: { name: "flat-foreign" } },
  ]);
  const env = { PI_CODING_AGENT_SESSION_DIR: flatDir };
  const localHit = run(["--resolve", "flat-local"], env);
  const localMiss = run(["--resolve", "flat-foreign"], env);
  const globalHit = run(["--resolve", "flat-foreign", "-g"], env);
  const ok =
    localHit.code === 0 && localHit.stdout === localPath &&
    localMiss.code === 2 && !claimsForeignMatch(localMiss.stdout + localMiss.stderr) &&
    globalHit.code === 0 && globalHit.stdout === foreignPath;
  return [
    ok,
    `localHit: exit ${localHit.code} stdout=${JSON.stringify(localHit.stdout)}; ` +
      `localMiss: exit ${localMiss.code}; globalHit: exit ${globalHit.code} stdout=${JSON.stringify(globalHit.stdout)}`,
  ];
});

// POSIX root normalizes to the empty string, which is a real scope. Only an
// absent scope may widen a lookup, so this guards the one platform where a
// truthiness check on the scope would silently behave like --global.
if (!isWin) {
  runCase("H5e: POSIX root is a scope, not an absent scope", () => {
    const flatDir = join(stubDir, "root-sessions");
    const rootPath = writeSessionAt(join(flatDir, "root.jsonl"), [
      { type: "session", cwd: "/", id: "root-scope" },
      ...history(4),
      { type: "custom", customType: "link-name", data: { name: "root-scoped" } },
    ]);
    const foreignPath = writeSessionAt(join(flatDir, "foreign.jsonl"), [
      { type: "session", cwd: join(stubDir, "other-cwd"), id: "root-foreign" },
      ...history(4),
      { type: "custom", customType: "link-name", data: { name: "root-foreign" } },
    ]);
    const env = { PI_CODING_AGENT_SESSION_DIR: flatDir };
    const localHit = run(["--resolve", "root-scoped"], env, "/");
    const localMiss = run(["--resolve", "root-foreign"], env, "/");
    const globalHit = run(["--resolve", "root-foreign", "-g"], env, "/");
    const localList = run(["--list"], env, "/");
    const globalList = run(["--list", "-g"], env, "/");
    const ok =
      localHit.code === 0 && localHit.stdout === rootPath &&
      localMiss.code === 2 && !claimsForeignMatch(localMiss.stdout + localMiss.stderr) &&
      globalHit.code === 0 && globalHit.stdout === foreignPath &&
      localList.stdout.includes("root-scoped") && !localList.stdout.includes("root-foreign") &&
      globalList.stdout.includes("root-scoped") && globalList.stdout.includes("root-foreign");
    return [
      ok,
      `localHit: exit ${localHit.code} stdout=${JSON.stringify(localHit.stdout)}; ` +
        `localMiss: exit ${localMiss.code}; globalHit: exit ${globalHit.code} stdout=${JSON.stringify(globalHit.stdout)}; ` +
        `localList=${JSON.stringify(localList.stdout)}`,
    ];
  });
}

runCase("H5d: list scopes to this cwd and keeps its message count", () => {
  writeSession(join("h5d-local", "local.jsonl"), [
    { type: "session", cwd: stubDir, id: "h5d-local" },
    { type: "custom", customType: "link-name", data: { name: "list-local" } },
    ...history(3),
  ]);
  writeSession(join("h5d-foreign", "foreign.jsonl"), [
    { type: "session", cwd: join(stubDir, "other-cwd"), id: "h5d-foreign" },
    { type: "custom", customType: "link-name", data: { name: "list-foreign" } },
    ...history(9),
  ]);
  const local = run(["--list"]);
  const global = run(["--list", "-g"]);
  // Columns are separated by at least two spaces: NAME MODIFIED MESSAGES ID.
  const localRow = local.stdout.split("\n").find((line) => line.startsWith("list-local"));
  const messages = localRow?.split(/\s{2,}/)[2];
  const ok =
    local.code === 0 &&
    messages === "3" &&
    !local.stdout.includes("list-foreign") &&
    global.code === 0 &&
    global.stdout.includes("list-local") &&
    global.stdout.includes("list-foreign");
  return [
    ok,
    `local: exit ${local.code} row=${JSON.stringify(localRow)} messages=${JSON.stringify(messages)} ` +
      `hasForeign=${local.stdout.includes("list-foreign")}; global: exit ${global.code} ` +
      `hasLocal=${global.stdout.includes("list-local")} hasForeign=${global.stdout.includes("list-foreign")}`,
  ];
});

runCase("H7: duplicate local names are ambiguous", () => {
  writeSession(join("h7-dupe-a", "first.jsonl"), [
    { type: "session", cwd: stubDir, id: "h7-dupe-a" },
    { type: "custom", customType: "link-name", data: { name: "dupe" } },
  ]);
  writeSession(join("h7-dupe-b", "second.jsonl"), [
    { type: "session", cwd: stubDir, id: "h7-dupe-b" },
    { type: "custom", customType: "link-name", data: { name: "dupe" } },
  ]);
  const r = run(["--resolve", "dupe"]);
  const output = r.stdout + r.stderr;
  return [
    r.code === 1 && output.includes("Multiple sessions named"),
    `exit ${r.code}, output=${JSON.stringify(output)}`,
  ];
});

const h10FilePath = writeSession(join("h10-resume", "existing.jsonl"), [
  { type: "session", cwd: stubDir, id: "h10-resume" },
  { type: "custom", customType: "link-name", data: { name: "resume-existing" } },
]);
expectSpawn("H10: launcher resumes existing local session", ["resume-existing"], ["--session", h10FilePath, "--link"], "resume-existing");

// I. Version
runCase("I43: --version prints semver", () => {
  const r = run(["--version"]);
  return [
    r.code === 0 && /^\d+\.\d+\.\d+/.test(r.stdout) && r.stderr === "",
    `exit ${r.code}, stdout=${JSON.stringify(r.stdout)}, stderr=${JSON.stringify(r.stderr)}`,
  ];
});
expectExit("I44: --version foo rejects arguments", ["--version", "foo"], 1, "does not accept arguments");
expectExit("I45: foo --version cannot combine", ["foo", "--version"], 1, "cannot combine");
expectExit("I46: --list --version cannot combine", ["--list", "--version"], 1, "cannot combine");

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n\nPassed: ${pass}`);
console.log(`Failed: ${fail}`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
}

try { rmSync(stubDir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
