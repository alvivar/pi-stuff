import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseBudget, MAX_BUDGET_MINUTES } from '../src/budget.mjs';
import { request } from '../src/pipe.mjs';
import { pipePath } from '../src/paths.mjs';

const filename = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(filename));
const runner = path.join(root, 'src', 'runner.mjs');

function manifest(id, revision = 0) {
  return {
    name: 'regression-agent',
    sessionFile: `session-${id}`,
    cwd: `cwd-${id}`,
    model: 'test/model',
    budget: 'off',
    flags: [],
    pipe: `pipe-${id}`,
    startedAt: `2026-01-01T00:00:${String(revision).padStart(2, '0')}Z`,
    revision,
    padding: 'x'.repeat(16 * 1024),
  };
}

function sandboxEnv(sandbox) {
  return {
    ...process.env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    HOMEDRIVE: '',
    HOMEPATH: '',
    APPDATA: path.join(sandbox, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(sandbox, 'AppData', 'Local'),
    PI_CODING_AGENT_DIR: path.join(sandbox, 'agent'),
    PI_CODING_AGENT_SESSION_DIR: path.join(sandbox, 'agent', 'sessions'),
    PI_OFFLINE: '1',
  };
}

function runWorker(sandbox, action, name, id = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filename, '--worker', action, name, id], {
      env: sandboxEnv(sandbox),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`worker ${action} exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`worker ${action} returned invalid JSON ${JSON.stringify(stdout)}: ${error.message}`));
      }
    });
  });
}

async function tempFiles(dock) {
  try {
    return (await fs.readdir(dock)).filter((entry) => entry.endsWith('.tmp'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function worker(action, name, id) {
  const { writeManifest, rewriteManifest } = await import('../src/manifest.mjs');
  try {
    if (action === 'create') {
      await writeManifest(name, manifest(id));
      process.stdout.write(JSON.stringify({ ok: true, id }));
      return;
    }

    if (action === 'rewrite-check') {
      const target = path.join(os.homedir(), '.pi', 'dock', `${name}.json`);
      for (let revision = 1; revision <= 20; revision += 1) {
        const next = manifest(id, revision);
        await rewriteManifest(name, next);
        assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), next);
      }
      process.stdout.write(JSON.stringify({ ok: true }));
      return;
    }

    throw new Error(`unknown worker action: ${action}`);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
  }
}

function launchRunner(sandbox, cwd, name, fixture) {
  return spawn(process.execPath, [runner, '--name', name, '--cwd', cwd, '--model', 'anthropic/claude-haiku-4-5', '--budget', 'off', '--x', fixture, '--create'], {
    env: sandboxEnv(sandbox),
    stdio: 'ignore',
    windowsHide: true,
  });
}

function runOwnedNode(sandbox, script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: sandboxEnv(sandbox),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function launchOwnedFollow(sandbox, name) {
  const child = spawn(process.execPath, [path.join(root, 'bin', 'pi-dock.mjs'), 'logs', name, '--follow'], {
    env: sandboxEnv(sandbox),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForFollowOutput(follower, predicate, timeoutMs = 5000) {
  if (predicate(follower.output())) {
    return;
  }
  let dataHandler;
  let closeHandler;
  let errorHandler;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      const finish = (error) => error ? reject(error) : resolve();
      dataHandler = () => {
        if (predicate(follower.output())) {
          finish();
        }
      };
      closeHandler = () => finish(new Error('follow process closed before expected output'));
      errorHandler = (error) => finish(error);
      timer = setTimeout(() => finish(new Error('follow process did not produce expected output')), timeoutMs);
      follower.child.stdout.on('data', dataHandler);
      follower.child.once('close', closeHandler);
      follower.child.once('error', errorHandler);
    });
  } finally {
    clearTimeout(timer);
    follower.child.stdout.off('data', dataHandler);
    follower.child.off('close', closeHandler);
    follower.child.off('error', errorHandler);
  }
}

async function stopOwnedFollow(follower) {
  if (follower.child.exitCode === null && follower.child.signalCode === null) {
    follower.child.kill();
  }
  await waitForExit(follower.child, 5000);
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function stateFromLs(output, name) {
  const line = output.split('\n').find((candidate) => candidate.startsWith(`${name}\t`));
  return line?.split('\t')[1] ?? null;
}

async function waitForStatus(pipe, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await request(pipe, { cmd: 'status' }, 250);
      if (status.ok) {
        return status;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let closeHandler;
  let timer;
  try {
    const result = await Promise.race([
      new Promise((resolve) => {
        closeHandler = (code, signal) => resolve({ code, signal });
        child.once('close', closeHandler);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`runner ${child.pid} did not exit`)), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
    child.off('close', closeHandler);
  }
}

async function stopOwnedRunner(child, pipe) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    await request(pipe, { cmd: 'stop' }, 3000);
    await waitForExit(child, 5000);
    return;
  } catch {}
  child.kill();
  await waitForExit(child, 5000);
}

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `pi-dock-regression-${randomUUID()}-`));
  const dock = path.join(sandbox, '.pi', 'dock');
  const ownedRunners = [];
  const ownedRunnerPipes = new Map();
  let primaryError;
  try {
    const raceName = 'manifest-race';
    const racers = await Promise.all(Array.from({ length: 12 }, (_, index) => runWorker(sandbox, 'create', raceName, `racer-${index}`)));
    const winners = racers.filter((result) => result.ok);
    const losers = racers.filter((result) => !result.ok);
    assert.equal(winners.length, 1, 'exactly one concurrent creator wins');
    assert.equal(losers.length, 11, 'every other concurrent creator loses');
    for (const loser of losers) {
      assert.equal(loser.error, `manifest already exists: ${raceName}`);
    }
    const winnerBody = await fs.readFile(path.join(dock, `${raceName}.json`), 'utf8');
    assert.deepEqual(JSON.parse(winnerBody), manifest(winners[0].id));
    assert.deepEqual(await tempFiles(dock), [], 'concurrent create leaves no temp files');

    const existingName = 'manifest-existing';
    assert.deepEqual(await runWorker(sandbox, 'create', existingName, 'original'), { ok: true, id: 'original' });
    const originalBody = await fs.readFile(path.join(dock, `${existingName}.json`), 'utf8');
    const existingResult = await runWorker(sandbox, 'create', existingName, 'replacement');
    assert.deepEqual(existingResult, { ok: false, error: `manifest already exists: ${existingName}` });
    assert.equal(await fs.readFile(path.join(dock, `${existingName}.json`), 'utf8'), originalBody, 'existing target is never replaced');
    assert.deepEqual(await tempFiles(dock), [], 'failed existing create leaves no temp files');

    const rewriteName = 'manifest-rewrite';
    assert.deepEqual(await runWorker(sandbox, 'create', rewriteName, 'before'), { ok: true, id: 'before' });
    const rewriteResult = await runWorker(sandbox, 'rewrite-check', rewriteName, 'after');
    assert.deepEqual(rewriteResult, { ok: true });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dock, `${rewriteName}.json`), 'utf8')), manifest('after', 20));
    assert.deepEqual(await tempFiles(dock), [], 'rewrite leaves no temp files');

    assert.deepEqual(parseBudget(`7,${MAX_BUDGET_MINUTES}`), { turns: 7, minutes: MAX_BUDGET_MINUTES });
    assert.equal(parseBudget('off'), 'off');
    for (const invalid of ['0', '-1', '1.5', '1,', ',1', '1,2,3', '1,no', '5.', 'Infinity', 'offx', `7,${MAX_BUDGET_MINUTES}.1`, `7,${MAX_BUDGET_MINUTES + 1}`]) {
      assert.throws(() => parseBudget(invalid), new Error(`invalid budget: ${invalid}`));
    }
    assert.throws(() => parseBudget({ turns: 7, minutes: MAX_BUDGET_MINUTES + 1 }, { manifest: true }), new Error(`invalid budget: {"turns":7,"minutes":35792}`));

    const legacyName = `legacy-${randomUUID()}`;
    const legacySession = path.join(sandbox, 'legacy-session.jsonl');
    const legacyManifest = { ...manifest('legacy'), name: legacyName, sessionFile: legacySession, model: 'anthropic/claude-haiku-4-5', modelId: 'claude-haiku-4-5', pipe: pipePath(legacyName) };
    await fs.writeFile(path.join(dock, `${legacyName}.json`), `${JSON.stringify(legacyManifest)}\n`);
    const setResult = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['set', legacyName, '--budget', 'off']);
    assert.equal(setResult.code, 0, setResult.stderr);
    const repairedManifest = JSON.parse(await fs.readFile(path.join(dock, `${legacyName}.json`), 'utf8'));
    assert.equal(repairedManifest.sessionFile, legacySession, 'set preserves legacy session identity');
    assert.equal(repairedManifest.model, 'anthropic/claude-haiku-4-5');
    assert.equal(Object.hasOwn(repairedManifest, 'modelId'), false, 'set rewrite removes durable legacy modelId');
    assert.match(setResult.stdout, new RegExp(`^${legacyName} model=anthropic/claude-haiku-4-5 `));

    const missingName = `missing-model-${randomUUID()}`;
    const missingSession = path.join(sandbox, 'must-not-open.jsonl');
    const missingManifest = { ...manifest('missing'), name: missingName, sessionFile: missingSession, modelId: 'legacy-only', pipe: pipePath(missingName) };
    delete missingManifest.model;
    const missingBody = `${JSON.stringify(missingManifest)}\n`;
    await fs.writeFile(path.join(dock, `${missingName}.json`), missingBody);
    const missingResult = await runOwnedNode(sandbox, runner, ['--name', missingName]);
    assert.equal(missingResult.code, 1);
    assert.equal(missingResult.signal, null);
    assert.equal(await fs.readFile(path.join(dock, `${missingName}.json`), 'utf8'), missingBody, 'missing-model wake does not mutate manifest');
    await assert.rejects(fs.access(missingSession), { code: 'ENOENT' });
    const missingEvents = (await fs.readFile(path.join(dock, `${missingName}.log`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(missingEvents.map((event) => event.event), ['failed']);
    assert.equal(missingEvents[0].reason, `manifest model missing: ${missingName} — set --model <provider/id> to repair`);

    const followName = `follow-${randomUUID()}`;
    const followManifest = { ...manifest('follow'), name: followName, pipe: pipePath(followName) };
    const followLog = path.join(dock, `${followName}.log`);
    const accentedEvent = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'text', text: 'café 😀' });
    await fs.writeFile(path.join(dock, `${followName}.json`), `${JSON.stringify(followManifest)}\n`);
    await fs.writeFile(followLog, `${accentedEvent}\n`);
    const follower = launchOwnedFollow(sandbox, followName);
    try {
      await waitForFollowOutput(follower, (output) => output.includes('café 😀'));
      const noGrowthOutput = follower.output();
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.equal(follower.output(), noGrowthOutput, 'no-growth poll emits nothing');

      const laterEvent = JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', event: 'text', text: 'later 😀' });
      await fs.appendFile(followLog, `${laterEvent}\n`);
      await waitForFollowOutput(follower, (output) => output.includes('later 😀'));
      assert.equal(countOccurrences(follower.output(), 'café 😀'), 1, 'accented event is emitted once');
      assert.equal(countOccurrences(follower.output(), 'later 😀'), 1, 'later emoji event is emitted once');

      const splitEvent = Buffer.from(`${JSON.stringify({ ts: '2026-01-01T00:00:02.000Z', event: 'text', text: 'split é 😀' })}\n`);
      const splitAt = splitEvent.indexOf(Buffer.from('é')) + 1;
      assert(splitAt > 0, 'split fixture contains a multibyte code point');
      const beforeSplit = follower.output();
      await fs.appendFile(followLog, splitEvent.subarray(0, splitAt));
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.equal(follower.output(), beforeSplit, 'torn multibyte event emits no corrupt or partial output');
      await fs.appendFile(followLog, splitEvent.subarray(splitAt));
      await waitForFollowOutput(follower, (output) => output.includes('split é 😀'));
      assert.equal(countOccurrences(follower.output(), 'split é 😀'), 1, 'completed multibyte event emits once');

      const orderedOne = JSON.stringify({ ts: '2026-01-01T00:00:03.000Z', event: 'text', text: 'ordered-one' });
      const orderedTwo = JSON.stringify({ ts: '2026-01-01T00:00:04.000Z', event: 'text', text: 'ordered-two' });
      await fs.appendFile(followLog, `${orderedOne}\n${orderedTwo}\n`);
      await waitForFollowOutput(follower, (output) => output.includes('ordered-one') && output.includes('ordered-two'));
      const followed = follower.output();
      assert(followed.indexOf('ordered-one') < followed.indexOf('ordered-two'), 'multiple complete events preserve order');
      assert.equal(countOccurrences(followed, 'ordered-one'), 1);
      assert.equal(countOccurrences(followed, 'ordered-two'), 1);
    } finally {
      await stopOwnedFollow(follower);
    }

    const absentLogName = `absent-follow-${randomUUID()}`;
    await fs.writeFile(path.join(dock, `${absentLogName}.json`), `${JSON.stringify({ ...manifest('absent-follow'), name: absentLogName, pipe: pipePath(absentLogName) })}\n`);
    const absentFollow = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['logs', absentLogName, '--follow']);
    assert.equal(absentFollow.code, 1);
    assert.equal(absentFollow.signal, null);
    assert.equal(absentFollow.stdout, '');
    assert.equal(absentFollow.stderr.trim(), `no log for agent: ${absentLogName}`);
    assert.equal(absentFollow.stderr.includes(sandbox), false, 'absent follow does not leak a sandbox path');

    const stateCases = [
      ['stopped', '{"event":"stopped"}\n', 'stopped'],
      ['stopped-torn', '{"event":"stopped"}\n{"event":', 'stopped'],
      ['failed-torn', '{"event":"failed"}\n{"event":', 'failed'],
      ['idle-torn', '{"event":"idle"}\n{"event":', 'failed'],
      ['only-torn', '{"event":', 'failed'],
      ['empty', '', 'failed'],
      ['missing', null, 'failed'],
    ];
    for (const [suffix, body, expectedState] of stateCases) {
      const stateName = `state-${suffix}-${randomUUID()}`;
      await fs.writeFile(path.join(dock, `${stateName}.json`), `${JSON.stringify({ ...manifest('state'), name: stateName, pipe: pipePath(stateName) })}\n`);
      if (body !== null) {
        await fs.writeFile(path.join(dock, `${stateName}.log`), body);
      }
      const lsResult = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['ls']);
      assert.equal(lsResult.code, 0, lsResult.stderr);
      assert.equal(stateFromLs(lsResult.stdout, stateName), expectedState, `${suffix} state`);
    }

    const runnerName = `t1-${randomUUID()}`;
    const runnerCwd = path.join(sandbox, 'trusted-empty-cwd');
    await fs.mkdir(runnerCwd);
    const fixtures = Array.from({ length: 6 }, (_, index) => `fixture-${index}`);
    const runners = fixtures.map((fixture) => launchRunner(sandbox, runnerCwd, runnerName, fixture));
    const pipe = pipePath(runnerName);
    for (const child of runners) {
      ownedRunners.push(child);
      ownedRunnerPipes.set(child, pipe);
    }
    const status = await waitForStatus(pipe);
    assert(status, 'one real create runner reaches its owned pipe');
    const winnerIndex = runners.findIndex((child) => child.pid === status.pid);
    assert.notEqual(winnerIndex, -1, 'status PID belongs to exactly one launched child');
    const loserExits = await Promise.all(runners.filter((child) => child !== runners[winnerIndex]).map((child) => waitForExit(child)));
    for (const loserExit of loserExits) {
      assert.equal(loserExit.code, 0, 'expected publication loser exits silently with code 0');
      assert.equal(loserExit.signal, null, 'expected publication loser is not killed');
    }
    const runnerManifest = JSON.parse(await fs.readFile(path.join(dock, `${runnerName}.json`), 'utf8'));
    assert.equal(runnerManifest.model, 'anthropic/claude-haiku-4-5', 'create persists its resolved qualified model');
    assert.equal(Object.hasOwn(runnerManifest, 'modelId'), false);
    assert.deepEqual(runnerManifest.flags, [fixtures[winnerIndex]], 'manifest configuration belongs to live pipe owner');
    const events = (await fs.readFile(path.join(dock, `${runnerName}.log`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.filter((event) => event.event === 'spawned').map((event) => event.pid), [status.pid]);
    assert.equal(events.some((event) => event.event === 'failed'), false, 'expected publication losers are silent');
    assert.deepEqual(await tempFiles(dock), [], 'real runner race leaves no manifest temp files');
    await stopOwnedRunner(runners[winnerIndex], pipe);

    console.log('regression: 9 cases passed');
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  for (const child of ownedRunners) {
    try {
      await stopOwnedRunner(child, ownedRunnerPipes.get(child));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await fs.rm(sandbox, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await fs.lstat(sandbox);
    cleanupErrors.push(new Error(`sandbox still exists: ${sandbox}`));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      cleanupErrors.push(error);
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], 'regression and cleanup failed');
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'regression cleanup failed');
  }
}

if (process.argv[2] === '--worker') {
  await worker(process.argv[3], process.argv[4], process.argv[5]);
} else {
  await main();
}
