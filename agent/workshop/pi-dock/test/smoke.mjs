import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseBudget } from '../src/budget.mjs';
import { dockDir, pipePath } from '../src/paths.mjs';

const cli = path.join(process.cwd(), 'bin', 'pi-dock.mjs');
const a = `smoke-${process.pid}-a`;
const b = `smoke-${process.pid}-b`;
const c = `smoke-${process.pid}-c`;
const d = `smoke-${process.pid}-d`;
const e = `smoke-${process.pid}-e`;
const f = `smoke-${process.pid}-f`;
const g = `smoke-${process.pid}-g`;
const h = `smoke-${process.pid}-h`;
const names = [a, b, c, d, e, f, g, h];
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

function count(text, needle) {
  return text.split(needle).length - 1;
}

function manifest(name) {
  return JSON.parse(readFileSync(dockFile(name, '.json'), 'utf8'));
}

function latestSpawned(name) {
  return readFileSync(dockFile(name, '.log'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === 'spawned')
    .at(-1);
}

function budgetError(value, options) {
  try {
    parseBudget(value, options);
  } catch (error) {
    return error.message;
  }
  return null;
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
  expect('budget parser normalizes legacy numeric object', JSON.stringify(parseBudget({ turns: 20, minutes: 30 }, { manifest: true })) === JSON.stringify({ turns: 20, minutes: 30 }), 'legacy object was rejected');
  for (const badBudget of [{}, { turns: 20, minutes: 'x' }, 20, [], '20,30']) {
    expect(`manifest budget rejects ${JSON.stringify(badBudget)}`, budgetError(badBudget, { manifest: true })?.startsWith('invalid budget: ') === true, budgetError(badBudget, { manifest: true }));
  }

  writeFileSync(dockFile(h, '.json'), `${JSON.stringify({ name: h, sessionFile: 'invalid-session', cwd: process.cwd(), modelId: null, model: null, budget: { turns: 20, minutes: 'x' }, flags: [], pipe: pipePath(h), startedAt: new Date().toISOString() })}\n`);
  let result = spawnSync(process.execPath, [path.join(process.cwd(), 'src', 'runner.mjs'), '--name', h], { cwd: process.cwd(), encoding: 'utf8' });
  const corruptLog = existsSync(dockFile(h, '.log')) ? readFileSync(dockFile(h, '.log'), 'utf8') : '';
  const corruptEvents = corruptLog.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  expect('corrupt resumed budget fails before spawned append', result.status !== 0 && corruptEvents.some((event) => event.event === 'failed' && event.reason === 'invalid budget: {"turns":20,"minutes":"x"}') && !corruptEvents.some((event) => event.event === 'spawned'), result.stderr || corruptLog);
  clean(h);

  result = run([]);
  const help = result.stdout;
  expect('bare help is static and complete', result.status === 0 && help.includes('pi-dock spawn') && help.includes('pi-dock compact') && help.includes('not responding') && help.includes('event:"text"') && help.includes('--budget') && help.includes('--follow'), result.stderr || help);

  result = run(['--help']);
  expect('long help matches bare help', result.status === 0 && result.stdout === help, result.stderr || result.stdout);

  result = run(['-h']);
  expect('short help matches bare help', result.status === 0 && result.stdout === help, result.stderr || result.stdout);

  result = run(['wat']);
  expect('unknown command is short and points to help', result.status === 1 && result.stderr.trim() === 'unknown command: wat; run pi-dock --help', result.stderr || result.stdout);

  for (const badBudget of ['0', '-1', '1.5', '1,0', '1,', ',1', '1,2,3', '1,no', '5.', 'Infinity', 'offx']) {
    result = run(['spawn', '--name', c, ...(badBudget.startsWith('-') ? [`--budget=${badBudget}`] : ['--budget', badBudget])]);
    expect(`invalid budget ${badBudget} leaves no manifest`, result.status === 1 && result.stderr.trim() === `invalid budget: ${badBudget}` && !existsSync(dockFile(c, '.json')) && !existsSync(dockFile(c, '.log')), result.stderr || result.stdout);
  }

  result = run(['spawn', '--name', e]);
  expect('omitted budget persists default', result.status === 0 && JSON.stringify(manifest(e).budget) === JSON.stringify({ turns: 20, minutes: 30 }), result.stderr || result.stdout);
  run(['stop', e]);

  result = run(['spawn', '--name', f, '--budget', '7']);
  expect('single budget defaults minutes to 30', result.status === 0 && JSON.stringify(manifest(f).budget) === JSON.stringify({ turns: 7, minutes: 30 }), result.stderr || result.stdout);
  run(['stop', f]);

  result = run(['spawn', '--name', g, '--budget', 'off']);
  expect('off budget persists verbatim', result.status === 0 && manifest(g).budget === 'off', result.stderr || result.stdout);
  result = run(['stop', g]);
  await waitLsState(g, 'stopped');
  result = run(['start', g]);
  const spawnedG = latestSpawned(g);
  expect('off survives wake with a live spawned pid', result.status === 0 && manifest(g).budget === 'off' && Number.isInteger(spawnedG?.pid) && spawnedG.pid > 0 && pidAlive(spawnedG.pid), result.stderr || result.stdout || JSON.stringify(spawnedG));
  run(['stop', g]);

  result = run(['spawn', '--name', a, '--budget', '5,5']);
  expect('spawn A idle without prompt', result.status === 0 && result.stdout.trim() === `${a} idle`, result.stderr || result.stdout);

  result = await waitLsState(a, 'idle');
  expect('ls shows A idle after spawn', result?.status === 0 && lsState(result.stdout, a) === 'idle', result?.stdout || result?.stderr);

  const pidA = findRunnerPid(a);
  expect('A runner process alive after spawn', Number.isInteger(pidA) && pidAlive(pidA), String(pidA));

  result = run(['send', a, 'Remember the token ALPHA-31. Reply exactly: alpha saved']);
  expect('send A first prompt acks', result.status === 0 && result.stdout.trim() === '{"ok":true}', result.stderr || result.stdout);

  await waitFor(() => {
    const logs = logText(a);
    const ls = run(['ls']);
    return logs.includes('alpha saved') && count(logs, ' idle') >= 1 && lsState(ls.stdout, a) === 'idle';
  });

  result = run(['ls']);
  let logs = logText(a);
  expect('A returns to idle after first prompt', result.status === 0 && lsState(result.stdout, a) === 'idle', result.stdout || result.stderr);
  expect('A log has spawned turn text idle', logs.includes(' spawned') && logs.includes(' turn ') && logs.includes('alpha saved') && logs.includes(' idle'), logs);
  expect('A log has no done event', !logs.includes(' done'), logs);
  expect('A runner stays alive after first prompt', findRunnerPid(a) === pidA && pidAlive(pidA), String(findRunnerPid(a)));

  result = run(['send', a, 'What token did I ask you to remember? Reply exactly: ALPHA-31']);
  expect('send A second prompt acks', result.status === 0 && result.stdout.trim() === '{"ok":true}', result.stderr || result.stdout);

  await waitFor(() => {
    const currentLogs = logText(a);
    const ls = run(['ls']);
    return currentLogs.includes('ALPHA-31') && count(currentLogs, ' idle') >= 2 && lsState(ls.stdout, a) === 'idle';
  });

  result = run(['ls']);
  logs = logText(a);
  expect('A remembers across resident runs', logs.includes('ALPHA-31'), logs);
  expect('A returns to idle after second prompt', result.status === 0 && lsState(result.stdout, a) === 'idle', result.stdout || result.stderr);
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
  expect('start A wakes idle without prompt', result.status === 0 && result.stdout.trim() === `${a} idle`, result.stderr || result.stdout);

  result = await waitLsState(a, 'idle');
  expect('ls shows A idle after start', result?.status === 0 && lsState(result.stdout, a) === 'idle', result?.stdout || result?.stderr);
  const pidAWoken = findRunnerPid(a);
  expect('A has new runner after start', Number.isInteger(pidAWoken) && pidAWoken !== pidA && pidAlive(pidAWoken), `${pidAWoken} vs ${pidA}`);

  result = run(['stop', a]);
  expect('stop A after start reports stopped', result.status === 0 && result.stdout.includes('stopped'), result.stderr || result.stdout);

  result = run(['spawn', '--name', b, '--budget', '5,5']);
  expect('spawn B idle without prompt', result.status === 0 && result.stdout.trim() === `${b} idle`, result.stderr || result.stdout);

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
  expect('start B revives idle', result.status === 0 && result.stdout.trim() === `${b} idle`, result.stderr || result.stdout);

  result = await waitLsState(b, 'idle');
  expect('ls shows B idle after start', result?.status === 0 && lsState(result.stdout, b) === 'idle', result?.stdout || result?.stderr);

  result = run(['stop', b]);
  expect('stop B after start reports stopped', result.status === 0 && result.stdout.includes('stopped'), result.stderr || result.stdout);

  result = run(['spawn', '--name', d, '--budget', '5,5', '--thinking', 'minimal', '--x', 'bogus-flag=1']);
  expect('spawn D with unknown extension flag and thinking idles', result.status === 0 && result.stdout.trim() === `${d} idle`, result.stderr || result.stdout);
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
  expect('set stopped D rewrites mutable identity', result.status === 0 && dAfterSet.model === 'anthropic/claude-haiku-4-5' && dAfterSet.modelId === 'claude-haiku-4-5' && dAfterSet.thinking === 'low' && JSON.stringify(dAfterSet.flags) === JSON.stringify(['link', `link-name=${d}`]), result.stderr || result.stdout || JSON.stringify(dAfterSet));
  expect('set stopped D preserves hard identity', dAfterSet.name === dBeforeSet.name && dAfterSet.sessionFile === dBeforeSet.sessionFile && dAfterSet.cwd === dBeforeSet.cwd && dAfterSet.pipe === dBeforeSet.pipe && dAfterSet.startedAt === dBeforeSet.startedAt, JSON.stringify({ before: dBeforeSet, after: dAfterSet }));

  const dBeforeInvalidBudget = readFileSync(dockFile(d, '.json'));
  result = run(['set', d, '--budget', '1,']);
  expect('invalid set budget leaves manifest unchanged', result.status === 1 && result.stderr.trim() === 'invalid budget: 1,' && Buffer.compare(dBeforeInvalidBudget, readFileSync(dockFile(d, '.json'))) === 0, result.stderr || result.stdout);

  result = run(['set', d, '--budget', '9,1.5']);
  expect('set numeric budget rewrites canonically', result.status === 0 && JSON.stringify(manifest(d).budget) === JSON.stringify({ turns: 9, minutes: 1.5 }) && result.stdout.includes('budget=9,1.5'), result.stderr || result.stdout);

  result = run(['set', d, '--budget', 'off']);
  expect('set off budget rewrites canonically', result.status === 0 && manifest(d).budget === 'off' && result.stdout.includes('budget=off'), result.stderr || result.stdout);

  result = run(['compact', 'missing-smoke-agent']);
  expect('compact missing agent errors', result.status !== 0 && result.stderr.includes('no such agent: missing-smoke-agent'), result.stderr || result.stdout);

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
  console.log(`PASS smoke ${results.length}/${results.length}`);
} else {
  const passed = results.filter(Boolean).length;
  console.log(`FAIL smoke ${passed}/${results.length}`);
  process.exit(1);
}
