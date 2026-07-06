import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dockDir } from '../src/paths.mjs';

const cli = path.join(process.cwd(), 'bin', 'pi-dock.mjs');
const a = `smoke-${process.pid}-a`;
const b = `smoke-${process.pid}-b`;
const c = `smoke-${process.pid}-c`;
const names = [a, b, c];
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

function expect(name, condition, detail) {
  if (condition) {
    pass(name);
  } else {
    fail(name, detail);
  }
}

function dockFile(name, suffix) {
  return path.join(dockDir(), `${name}${suffix}`);
}

function clean(name) {
  rmSync(dockFile(name, '.json'), { force: true });
  rmSync(dockFile(name, '.log'), { force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lsState(output, name) {
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] === name) {
      return columns[1];
    }
  }

  return null;
}

async function waitLsState(name, state) {
  for (let i = 0; i < 240; i += 1) {
    const result = run(['ls']);
    if (result.status === 0 && lsState(result.stdout, name) === state) {
      return result;
    }
    await sleep(500);
  }

  return run(['ls']);
}

function logText(name) {
  const result = run(['logs', name]);
  return result.status === 0 ? result.stdout : '';
}

function count(text, needle) {
  return text.split(needle).length - 1;
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

function killRunner(name) {
  const pid = findRunnerPid(name);
  if (pid) {
    killPid(pid);
  }
}

for (const name of names) {
  clean(name);
}

try {
  let result = run(['spawn', '--name', a, '--budget', '5,5', 'Reply with exactly: alpha']);
  expect('spawn A with alpha', result.status === 0 && result.stdout.trim() === `${a} idle`, result.stderr || result.stdout);

  result = await waitLsState(a, 'done');
  expect('ls shows A done', result.status === 0 && lsState(result.stdout, a) === 'done', result.stdout || result.stderr);

  let logs = logText(a);
  expect('logs A has spawned turn text alpha done', logs.includes(' spawned') && logs.includes(' turn ') && logs.includes('alpha') && logs.includes(' done'), logs);

  const manifestAfterStep1 = readFileSync(dockFile(a, '.json'));

  result = run(['send', a, 'Reply with exactly: beta']);
  expect('send A resurrects and acks beta', result.status === 0 && result.stdout.trim() === '{"ok":true}', result.stderr || result.stdout);

  result = await waitLsState(a, 'done');
  expect('ls shows A done after beta', result.status === 0 && lsState(result.stdout, a) === 'done', result.stdout || result.stderr);

  logs = logText(a);
  expect('logs A has second spawned turn text beta done', count(logs, ' spawned') >= 2 && count(logs, ' turn ') >= 2 && logs.includes('beta') && count(logs, ' done') >= 2, logs);
  expect('manifest A unchanged after resurrect', Buffer.compare(manifestAfterStep1, readFileSync(dockFile(a, '.json'))) === 0, 'manifest bytes changed');

  result = run(['spawn', '--name', b]);
  expect('spawn B idle no prompt', result.status === 0 && result.stdout.trim() === `${b} idle`, result.stderr || result.stdout);

  result = await waitLsState(b, 'idle');
  expect('ls shows B idle', result.status === 0 && lsState(result.stdout, b) === 'idle', result.stdout || result.stderr);

  const pid = findRunnerPid(b);
  expect('find B runner pid', Number.isInteger(pid), String(pid));
  if (pid) {
    killPid(pid);
  }

  await sleep(500);
  result = await waitLsState(b, 'failed');
  expect('ls shows killed B failed', result.status === 0 && lsState(result.stdout, b) === 'failed', result.stdout || result.stderr);

  result = run(['stop', b]);
  expect('stop killed B reports derived state', result.status === 0 && result.stdout.includes('already failed'), result.stderr || result.stdout);

  result = run(['spawn', '--name', c, '--model', 'bogus/bogus']);
  expect('bad model preflight exits nonzero', result.status !== 0 && result.stderr.includes('preflight failed: model bogus/bogus not found; no agent was created'), result.stderr || result.stdout);
  expect('bad model leaves no manifest or log', !existsSync(dockFile(c, '.json')) && !existsSync(dockFile(c, '.log')), `${dockFile(c, '.json')} / ${dockFile(c, '.log')}`);
} finally {
  for (const name of names) {
    killRunner(name);
    clean(name);
  }
}

expect('cleanup leaves no dock files', names.every((name) => !existsSync(dockFile(name, '.json')) && !existsSync(dockFile(name, '.log'))), 'leftover dock files');

if (results.every(Boolean)) {
  console.log('PASS smoke');
} else {
  console.log('FAIL smoke');
  process.exit(1);
}
