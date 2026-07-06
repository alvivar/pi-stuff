import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { dockDir } from '../src/paths.mjs';

const cli = path.join(process.cwd(), 'bin', 'pi-dock.mjs');
const first = `smoke-${process.pid}-a`;
const second = `smoke-${process.pid}-b`;
const results = [];

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function pass(name) {
  results.push(true);
  console.log(`PASS ${name}`);
}

function fail(name, detail) {
  results.push(false);
  console.log(`FAIL ${name}: ${detail}`);
}

function clean(name) {
  rmSync(path.join(dockDir(), `${name}.json`), { force: true });
  rmSync(path.join(dockDir(), `${name}.log`), { force: true });
}

function expect(name, condition, detail) {
  if (condition) {
    pass(name);
  } else {
    fail(name, detail);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findRunnerPid(name) {
  const escaped = name.replaceAll("'", "''");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*src\\runner.mjs*--name*${escaped}*' -or $_.CommandLine -like '*src/runner.mjs*--name*${escaped}*' } | Select-Object -First 1 -ExpandProperty ProcessId`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
  return output ? Number(output) : null;
}

function killPid(pid) {
  spawnSync('taskkill.exe', ['/F', '/PID', String(pid)], { encoding: 'utf8' });
}

clean(first);
clean(second);

try {
  let result = run(['spawn', '--name', first, 'x']);
  expect('spawn first', result.status === 0 && result.stdout.includes(first), result.stderr || result.stdout);

  result = run(['ls']);
  expect('ls shows first running/idle', result.status === 0 && new RegExp(`${first}\\s+(running|idle)`).test(result.stdout), result.stdout || result.stderr);

  await sleep(2500);
  result = run(['logs', first]);
  expect('logs shows spawned and heartbeat', result.status === 0 && result.stdout.includes(' spawned') && result.stdout.includes(' heartbeat'), result.stdout || result.stderr);

  result = run(['stop', first]);
  expect('stop first', result.status === 0 && result.stdout.includes('stopped'), result.stdout || result.stderr);

  await sleep(500);
  result = run(['ls']);
  expect('ls shows first stopped', result.status === 0 && new RegExp(`${first}\\s+stopped`).test(result.stdout), result.stdout || result.stderr);

  result = run(['spawn', '--name', second, 'x']);
  expect('spawn second', result.status === 0 && result.stdout.includes(second), result.stderr || result.stdout);

  await sleep(2500);
  const pid = findRunnerPid(second);
  expect('find second runner pid', Number.isInteger(pid), String(pid));

  if (pid) {
    killPid(pid);
  }

  await sleep(500);
  result = run(['ls']);
  expect('ls shows killed second failed', result.status === 0 && new RegExp(`${second}\\s+failed`).test(result.stdout), result.stdout || result.stderr);
} finally {
  const pid = findRunnerPid(second);
  if (pid) {
    killPid(pid);
  }
  clean(first);
  clean(second);
}

if (results.every(Boolean)) {
  console.log('PASS smoke');
} else {
  console.log('FAIL smoke');
  process.exit(1);
}
