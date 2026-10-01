import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dockDir } from '../src/paths.mjs';

const cli = path.join(process.cwd(), 'bin', 'pi-dock.mjs');
const a = `smoke-${process.pid}-a`;
const b = `smoke-${process.pid}-b`;
const c = `smoke-${process.pid}-c`;
const d = `smoke-${process.pid}-d`;
const e = `smoke-${process.pid}-e`;
const names = [a, b, c, d, e];
const results = [];

function run(args, timeout) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout,
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

async function waitFor(predicate) {
  for (let i = 0; i < 240; i += 1) {
    const value = predicate();
    if (value) {
      return value;
    }
    await sleep(500);
  }

  return predicate();
}

async function waitLsState(name, state) {
  return waitFor(() => {
    const result = run(['ls']);
    return result.status === 0 && lsState(result.stdout, name) === state ? result : null;
  });
}

function logText(name) {
  const result = run(['logs', name]);
  return result.status === 0 ? result.stdout : '';
}

function manifest(name) {
  return JSON.parse(readFileSync(dockFile(name, '.json'), 'utf8'));
}

function logEvents(name) {
  return readFileSync(dockFile(name, '.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function latestSpawned(name) {
  return logEvents(name).filter((event) => event.event === 'spawned').at(-1);
}

function findRunnerPid(name) {
  const escaped = name.replaceAll("'", "''");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*src\\runner.mjs*--name*${escaped}*' -or $_.CommandLine -like '*src/runner.mjs*--name*${escaped}*' } | Select-Object -First 1 -ExpandProperty ProcessId`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
  return output ? Number(output) : null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid)) {
    return false;
  }

  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' }`], { encoding: 'utf8' });
  return result.stdout.trim() === 'yes';
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
  let result = run([]);
  const help = result.stdout;
  expect('bare help is static and complete', result.status === 0 && help.includes('pi-dock spawn') && help.includes('pi-dock compact') && help.includes('pi-dock models') && help.includes('pi-dock skill') && help.includes('read the output of pi-dock skill'), result.stderr || help);

  result = run(['skill']);
  expect('skill prints the operating guide', result.status === 0 && result.stdout === readFileSync(path.join(process.cwd(), 'skills', 'pi-dock', 'SKILL.md'), 'utf8') && result.stdout.includes('not responding') && result.stdout.includes('event:"text"') && result.stdout.includes('--follow'), result.stderr || result.stdout);

  result = run(['--help']);
  expect('long help matches bare help', result.status === 0 && result.stdout === help, result.stderr || result.stdout);

  result = run(['-h']);
  expect('short help matches bare help', result.status === 0 && result.stdout === help, result.stderr || result.stdout);

  result = run(['wat']);
  expect('unknown command is short and points to help', result.status === 1 && result.stderr.trim() === 'unknown command: wat; run pi-dock --help', result.stderr || result.stdout);

  result = run(['spawn', '--name', e]);
  expect('spawn manifest holds only known fields', result.status === 0 && JSON.stringify(Object.keys(manifest(e)).sort()) === JSON.stringify(['cwd', 'flags', 'model', 'name', 'pipe', 'sessionFile', 'startedAt']), result.stderr || result.stdout || JSON.stringify(manifest(e)));
  result = run(['stop', e]);
  await waitLsState(e, 'stopped');
  result = run(['start', e]);
  const spawnedE = latestSpawned(e);
  expect('wake logs a live spawned pid', result.status === 0 && Number.isInteger(spawnedE?.pid) && spawnedE.pid > 0 && pidAlive(spawnedE.pid), result.stderr || result.stdout || JSON.stringify(spawnedE));
  run(['stop', e]);

  result = run(['spawn', '--name', a]);
  expect('spawn A idle without prompt', result.status === 0 && result.stdout.trim() === `${a} idle ${manifest(a).model}`, result.stderr || result.stdout);

  result = await waitLsState(a, 'idle');
  expect('ls shows A idle after spawn', result?.status === 0 && lsState(result.stdout, a) === 'idle', result?.stdout || result?.stderr);
  expect('ls shows A model and age', result?.stdout.split('\n').some((line) => /^\d+[smhd]$/.test(line.split('\t')[3]) && line.split('\t').slice(0, 3).join('\t') === `${a}\tidle\t${manifest(a).model}`), result?.stdout);

  const pidA = findRunnerPid(a);
  expect('A runner process alive after spawn', Number.isInteger(pidA) && pidAlive(pidA), String(pidA));

  const first = run(['send', a, '--wait', 'Remember the token ALPHA-31. Reply exactly: alpha saved'], 120000);
  const firstId = first.stderr.trim();
  expect('send --wait A first prompt prints its id on stderr', first.status === 0 && /^p[0-9a-f]{12}$/.test(firstId), first.stderr || first.stdout);
  expect('send --wait A prints the final text', first.stdout.includes('alpha saved'), first.stdout);

  result = run(['wait', a, firstId]);
  expect('wait A re-attaches to the finished first prompt', result.status === 0 && result.stdout === first.stdout, result.stderr || result.stdout);

  result = await waitLsState(a, 'idle');
  const logs = logText(a);
  expect('A returns to idle after first prompt', result?.status === 0 && lsState(result.stdout, a) === 'idle', result?.stdout || result?.stderr);
  expect('A log has spawned queued run turn text done', logs.includes(' spawned') && [' queued', ' run', ' turn', ' done'].every((event) => logs.includes(`${event} id=${firstId}`)) && logs.includes('alpha saved'), logs);
  expect('A reply text carries the send id', logEvents(a).some((event) => event.event === 'text' && event.id === firstId && event.text.includes('alpha saved')), logs);
  expect('A runner stays alive after first prompt', findRunnerPid(a) === pidA && pidAlive(pidA), String(findRunnerPid(a)));

  result = run(['send', a, '--wait', 'What token did I ask you to remember? Reply exactly: ALPHA-31'], 120000);
  const secondId = result.stderr.trim();
  expect('send --wait A second prompt prints a new id', result.status === 0 && /^p[0-9a-f]{12}$/.test(secondId) && secondId !== firstId, result.stderr || result.stdout);
  expect('A remembers across resident runs', result.stdout.includes('ALPHA-31'), result.stdout);
  expect('A log has done for the second id', logText(a).includes(` done id=${secondId}`), logText(a));

  result = await waitLsState(a, 'idle');
  expect('A returns to idle after second prompt', result?.status === 0 && lsState(result.stdout, a) === 'idle', result?.stdout || result?.stderr);
  expect('A runner stays alive after second prompt', findRunnerPid(a) === pidA && pidAlive(pidA), String(findRunnerPid(a)));

  const manifestBytes = readFileSync(dockFile(a, '.json'));
  const sessionFile = manifest(a).sessionFile;
  result = run(['stop', a]);
  expect('stop A reports stopped', result.status === 0 && result.stdout.includes('stopped'), result.stderr || result.stdout);

  result = await waitLsState(a, 'stopped');
  expect('ls shows A stopped', result?.status === 0 && lsState(result.stdout, a) === 'stopped', result?.stdout || result?.stderr);
  expect('A manifest log session survive stop', existsSync(dockFile(a, '.json')) && existsSync(dockFile(a, '.log')) && existsSync(sessionFile), sessionFile);
  expect('A manifest unchanged after stop', Buffer.compare(manifestBytes, readFileSync(dockFile(a, '.json'))) === 0, 'manifest bytes changed');

  result = run(['start', a]);
  expect('start A wakes idle without prompt', result.status === 0 && result.stdout.trim() === `${a} idle ${manifest(a).model}`, result.stderr || result.stdout);

  result = await waitLsState(a, 'idle');
  expect('ls shows A idle after start', result?.status === 0 && lsState(result.stdout, a) === 'idle', result?.stdout || result?.stderr);
  const pidAWoken = findRunnerPid(a);
  expect('A has new runner after start', Number.isInteger(pidAWoken) && pidAWoken !== pidA && pidAlive(pidAWoken), `${pidAWoken} vs ${pidA}`);

  result = run(['stop', a]);
  expect('stop A after start reports stopped', result.status === 0 && result.stdout.includes('stopped'), result.stderr || result.stdout);

  result = run(['spawn', '--name', b]);
  expect('spawn B idle without prompt', result.status === 0 && result.stdout.trim() === `${b} idle ${manifest(b).model}`, result.stderr || result.stdout);

  result = await waitLsState(b, 'idle');
  expect('ls shows B idle', result?.status === 0 && lsState(result.stdout, b) === 'idle', result?.stdout || result?.stderr);

  const pidB = findRunnerPid(b);
  expect('find B runner pid', Number.isInteger(pidB), String(pidB));
  if (pidB) {
    killPid(pidB);
  }

  result = await waitLsState(b, 'failed');
  expect('ls shows killed idle B failed', result?.status === 0 && lsState(result.stdout, b) === 'failed', result?.stdout || result?.stderr);

  result = run(['start', b]);
  expect('start B revives idle', result.status === 0 && result.stdout.trim() === `${b} idle ${manifest(b).model}`, result.stderr || result.stdout);

  result = await waitLsState(b, 'idle');
  expect('ls shows B idle after start', result?.status === 0 && lsState(result.stdout, b) === 'idle', result?.stdout || result?.stderr);

  result = run(['stop', b]);
  expect('stop B after start reports stopped', result.status === 0 && result.stdout.includes('stopped'), result.stderr || result.stdout);

  result = run(['spawn', '--name', d, '--thinking', 'minimal', '--x', 'bogus-flag=1']);
  expect('spawn D with unknown extension flag and thinking idles', result.status === 0 && result.stdout.trim() === `${d} idle ${manifest(d).model}`, result.stderr || result.stdout);
  expect('D manifest records raw flags and thinking', JSON.stringify(manifest(d).flags) === JSON.stringify(['bogus-flag=1']) && manifest(d).thinking === 'minimal', JSON.stringify(manifest(d)));

  result = run(['set', 'missing-smoke-agent', '--thinking', 'low']);
  expect('set missing agent errors', result.status !== 0 && result.stderr.includes('no such agent: missing-smoke-agent'), result.stderr || result.stdout);

  result = run(['set', d, '--thinking', 'low']);
  expect('set live D refuses', result.status !== 0 && result.stderr.includes(`agent ${d} is running — stop it first`), result.stderr || result.stdout);

  result = run(['stop', d]);
  expect('stop D after extension-flag spawn reports stopped', result.status === 0 && result.stdout.includes('stopped'), result.stderr || result.stdout);

  result = await waitLsState(d, 'stopped');
  expect('ls shows D stopped before set', result?.status === 0 && lsState(result.stdout, d) === 'stopped', result?.stdout || result?.stderr);

  result = run(['set', d]);
  expect('set with no options shows usage', result.status !== 0 && result.stderr.includes('usage: pi-dock set <name>'), result.stderr || result.stdout);

  const dBeforeSet = manifest(d);
  result = run(['set', d, '--model', 'anthropic/claude-haiku-4-5', '--thinking', 'low', '--x', 'link', '--x', `link-name=${d}`]);
  const dAfterSet = manifest(d);
  expect('set stopped D rewrites mutable identity', result.status === 0 && dAfterSet.model === 'anthropic/claude-haiku-4-5' && dAfterSet.thinking === 'low' && JSON.stringify(dAfterSet.flags) === JSON.stringify(['link', `link-name=${d}`]) && result.stdout.includes('model=anthropic/claude-haiku-4-5'), result.stderr || result.stdout || JSON.stringify(dAfterSet));
  expect('set stopped D preserves hard identity', dAfterSet.name === dBeforeSet.name && dAfterSet.sessionFile === dBeforeSet.sessionFile && dAfterSet.cwd === dBeforeSet.cwd && dAfterSet.pipe === dBeforeSet.pipe && dAfterSet.startedAt === dBeforeSet.startedAt, JSON.stringify({ before: dBeforeSet, after: dAfterSet }));

  result = run(['compact', 'missing-smoke-agent']);
  expect('compact missing agent errors', result.status !== 0 && result.stderr.includes('no such agent: missing-smoke-agent'), result.stderr || result.stdout);

  result = run(['spawn', '--name', c, '--model', 'bogus/bogus']);
  expect('bad model preflight exits nonzero', result.status !== 0 && result.stderr.includes('preflight failed: model bogus/bogus not found (see: pi-dock models); no agent was created'), result.stderr || result.stdout);
  expect('bad model leaves no manifest or log', !existsSync(dockFile(c, '.json')) && !existsSync(dockFile(c, '.log')), `${dockFile(c, '.json')} / ${dockFile(c, '.log')}`);
} finally {
  for (const name of names) {
    killRunner(name);
    clean(name);
  }
}

expect('cleanup leaves no dock files', names.every((name) => !existsSync(dockFile(name, '.json')) && !existsSync(dockFile(name, '.log'))), 'leftover dock files');

if (results.every(Boolean)) {
  console.log(`PASS smoke ${results.length}/${results.length}`);
} else {
  const passed = results.filter(Boolean).length;
  console.log(`FAIL smoke ${passed}/${results.length}`);
  process.exit(1);
}
