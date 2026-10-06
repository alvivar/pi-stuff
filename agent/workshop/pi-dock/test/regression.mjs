import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { request, serve } from '../src/pipe.mjs';
import { logPath, manifestPath, pipePath, validateAgentName } from '../src/paths.mjs';

const filename = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(filename));
const runner = path.join(root, 'src', 'runner.mjs');

function manifest(id, revision = 0) {
  return {
    name: 'regression-agent',
    sessionFile: `session-${id}`,
    cwd: `cwd-${id}`,
    model: 'test/model',
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

async function treeEntries(dir, relative = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = path.join(relative, entry.name);
    result.push(`${entry.isDirectory() ? 'd' : 'f'}:${childRelative}`);
    if (entry.isDirectory()) {
      result.push(...await treeEntries(path.join(dir, entry.name), childRelative));
    }
  }
  return result;
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

function launchRunner(sandbox, args) {
  return spawn(process.execPath, [runner, ...args], {
    env: sandboxEnv(sandbox),
    stdio: 'ignore',
    windowsHide: true,
  });
}

// A local OpenAI-compatible provider that records each request's last message and answers with the next scripted reply.
function startFauxProvider() {
  const replies = [];
  const prompts = [];
  let unexpected = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.once('end', () => {
      prompts.push(JSON.parse(body).messages.at(-1).content);
      const reply = replies.shift();
      if (reply) {
        reply(res);
        return;
      }
      unexpected += 1;
      res.writeHead(400).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    replies,
    prompts,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    unexpected: () => unexpected,
  })));
}

function sse(chunks) {
  return (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify({ id: 'faux', choices: [{ index: 0, ...chunk }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  };
}

function textReply(text) {
  return sse([{ delta: { content: text } }, { delta: {}, finish_reason: 'stop' }]);
}

function serverError(res) {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'faux overloaded' } }));
}

function held(reply) {
  let arrive;
  let release;
  const arrived = new Promise((resolve) => { arrive = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  return { reply: (res) => { arrive(); void released.then(() => reply(res)); }, arrived, release };
}

async function logEvents(dock, name) {
  return (await fs.readFile(path.join(dock, `${name}.log`), 'utf8')).trim().split('\n').map(JSON.parse);
}

async function waitForLog(dock, name, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await logEvents(dock, name);
    if (predicate(events)) {
      return events;
    }
    if (Date.now() > deadline) {
      throw new Error(`log of ${name} did not reach the expected state: ${JSON.stringify(events)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function withoutTimes(events) {
  return events.filter((event) => event.event !== 'spawned').map(({ ts: _ts, ...event }) => event);
}

function eventsOf(events, id) {
  return withoutTimes(events).filter((event) => event.id === id || event.ids?.includes(id));
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
  const line = output.split('\n').find((candidate) => candidate.split(/ +/)[0] === name);
  return line?.split(/ +/)[1] ?? null;
}

async function waitForServer(server) {
  if (server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    const listening = () => finish();
    const error = (failure) => finish(failure);
    const finish = (failure) => {
      server.off('listening', listening);
      server.off('error', error);
      failure ? reject(failure) : resolve();
    };
    server.once('listening', listening);
    server.once('error', error);
  });
}

async function closeOwnedServer(server, sockets = new Set()) {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (!server.listening) {
    return;
  }
  try {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } catch (error) {
    if (error.code !== 'ERR_SERVER_NOT_RUNNING') {
      throw error;
    }
  }
}

async function withOwnedServer(server, sockets, work) {
  let primaryError;
  try {
    await waitForServer(server);
    return await work();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await closeOwnedServer(server, sockets);
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError([primaryError, cleanupError], 'server fixture and cleanup failed');
      }
      throw cleanupError;
    }
  }
}

async function writeSetFixture(dock, name) {
  const fixture = {
    ...manifest('set'),
    name,
    sessionFile: `session-${name}.jsonl`,
    model: 'anthropic/claude-haiku-4-5',
    pipe: pipePath(name),
  };
  const target = path.join(dock, `${name}.json`);
  await fs.writeFile(target, `${JSON.stringify(fixture)}\n`);
  return target;
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
  const provider = await startFauxProvider();
  let primaryError;
  try {
    const validNames = [
      'a', 'haiku1', 'dockcheck-202610', 'segmented.name-part_1', 'a.b.c',
      'x'.repeat(64), 'console', 'auxiliary', 'com0', 'com10', 'lpt10',
    ];
    for (const name of validNames) {
      assert.equal(validateAgentName(name), name);
      assert.match(manifestPath(name), new RegExp(`${name.replace(/[.]/g, '\\.')}.json$`));
      assert.match(logPath(name), new RegExp(`${name.replace(/[.]/g, '\\.')}.log$`));
      assert.match(pipePath(name), new RegExp(name.replace(/[.]/g, '\\.')));
    }
    const invalidNames = [
      '', 'x'.repeat(65), 'Upper', 'café', 'a b', 'a\tb', 'a\nb', 'a\u0000b',
      'a/b', 'a\\b', 'a:b', '../escape', '..\\escape', '.start', 'end.', 'a..b', 'a--b', 'a._b',
      'con', 'CON', 'con.txt', 'con.txt.more', 'com1', 'com1.agent', 'lpt9', 'lpt9.x', 'prn', 'aux', 'nul', null, undefined,
    ];
    for (const name of invalidNames) {
      const expected = new Error(`invalid agent name: ${name}`);
      assert.throws(() => validateAgentName(name), expected);
      assert.throws(() => manifestPath(name), expected);
      assert.throws(() => logPath(name), expected);
      assert.throws(() => pipePath(name), expected);
    }

    const traversalName = '../t5-sentinel';
    const sentinelDir = path.join(sandbox, '.pi');
    const sentinelManifest = path.join(sentinelDir, 't5-sentinel.json');
    const sentinelLog = path.join(sentinelDir, 't5-sentinel.log');
    await fs.mkdir(sentinelDir, { recursive: true });
    await fs.writeFile(sentinelManifest, 'manifest sentinel');
    await fs.writeFile(sentinelLog, 'log sentinel');
    const beforeInvalidCliTree = await treeEntries(sandbox);
    const namedCommands = [
      ['spawn', '--name', traversalName],
      ['send', traversalName, 'text'],
      ['start', traversalName],
      ['stop', traversalName],
      ['logs', traversalName],
      ['set', traversalName, '--thinking', 'low'],
      ['compact', traversalName, 'instructions'],
    ];
    for (const commandArgs of namedCommands) {
      const result = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), commandArgs);
      assert.equal(result.code, 1, `${commandArgs[0]} invalid-name exit`);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim(), `invalid agent name: ${traversalName}`, `${commandArgs[0]} invalid-name error`);
    }
    assert.equal(await fs.readFile(sentinelManifest, 'utf8'), 'manifest sentinel');
    assert.equal(await fs.readFile(sentinelLog, 'utf8'), 'log sentinel');
    assert.deepEqual(await treeEntries(sandbox), beforeInvalidCliTree, 'invalid commands do not alter the owned sandbox tree');

    const valid64Name = 'v'.repeat(64);
    const valid64Result = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['start', valid64Name]);
    assert.equal(valid64Result.code, 1);
    assert.equal(valid64Result.stderr.trim(), `no such agent: ${valid64Name}`);
    const validSegmentedName = 'valid.segment-1';
    const validSegmentedResult = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['send', validSegmentedName, 'text']);
    assert.equal(validSegmentedResult.code, 1);
    assert.equal(validSegmentedResult.stderr.trim(), `no such agent: ${validSegmentedName}`);

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

    const staleName = `stale-${randomUUID()}`;
    const staleSession = path.join(sandbox, 'stale-session.jsonl');
    const staleManifest = { ...manifest('stale'), name: staleName, sessionFile: staleSession, model: 'anthropic/claude-haiku-4-5', modelId: 'claude-haiku-4-5', pipe: pipePath(staleName) };
    await fs.writeFile(path.join(dock, `${staleName}.json`), `${JSON.stringify(staleManifest)}\n`);
    const setResult = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['set', staleName, '--thinking', 'low']);
    assert.equal(setResult.code, 0, setResult.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dock, `${staleName}.json`), 'utf8')), {
      name: staleName,
      sessionFile: staleSession,
      cwd: staleManifest.cwd,
      model: 'anthropic/claude-haiku-4-5',
      thinking: 'low',
      flags: [],
      pipe: staleManifest.pipe,
      startedAt: staleManifest.startedAt,
    }, 'set rewrites only known manifest fields');
    assert.equal(setResult.stdout.trim(), `${staleName} model=anthropic/claude-haiku-4-5 thinking=low flags=[]`);

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

    const usage = {
      ls: 'pi-dock ls',
      stop: 'pi-dock stop <name>...',
      start: 'pi-dock start <name>',
      logs: 'pi-dock logs <name> [--tail <n>] [--raw] [--follow]',
      models: 'pi-dock models [filter]',
      send: 'pi-dock send <name> [--wait] [--file <path>] [--] [text...]',
      wait: 'pi-dock wait <name> <id>',
      skill: 'pi-dock skill',
      '--help': 'pi-dock [--help | -h]',
      '-h': 'pi-dock [--help | -h]',
      spawn: 'pi-dock spawn --name <name> [--model <provider/id>] [--thinking <level>] [--x key[=value]]...',
      set: 'pi-dock set <name> [--model <provider/id>] [--thinking <level>] [--x key[=value]]...',
    };
    const emptyPrompt = path.join(sandbox, 'empty-prompt.txt');
    await fs.writeFile(emptyPrompt, '');
    const rejected = [
      [['ls', '--json'], "Unknown option '--json'"],
      [['stop', 'v1', '--force'], "Unknown option '--force'"],
      [['stop'], undefined],
      [['start', 'v1', '--force'], "Unknown option '--force'"],
      [['logs', 'v1', 'other'], "Unexpected argument 'other'"],
      [['logs', 'v1', '--follow=yes'], "Option '-f, --follow' does not take an argument"],
      [['models', 'a', 'b'], "Unexpected argument 'b'"],
      [['spawn', '-n', 'v1'], "Unknown option '-n'"],
      [['spawn', '--name'], "Option '--name <value>' argument missing"],
      [['spawn', '--name', '--model', 'x'], "Option '--name' argument is ambiguous"],
      [['send', 'v1', '--wait-for', 'x'], "Unknown option '--wait-for'"],
      [['send', 'v1', 'text', '--file'], "Option '--file <value>' argument missing"],
      [['send', 'v1', ''], 'empty prompt'],
      [['send', 'v1', '--file', emptyPrompt], 'empty prompt'],
      [['send', 'v1'], undefined],
      [['send', 'v1', '--file', emptyPrompt, 'text'], undefined],
      [['wait', 'v1'], undefined],
      [['wait', 'v1', 'p1', 'p2'], "Unexpected argument 'p2'"],
      [['wait', 'v1', 'p1', '--json'], "Unknown option '--json'"],
      [['--help', 'extra'], "Unexpected argument 'extra'"],
      [['skill', 'extra'], "Unexpected argument 'extra'"],
      [['skill', '--json'], "Unknown option '--json'"],
      [['-h', '--json'], "Unknown option '--json'"],
    ];
    for (const [commandArgs, reason] of rejected) {
      const result = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), commandArgs);
      assert.equal(result.code, 1, commandArgs.join(' '));
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${reason ? `${reason}\n` : ''}usage: ${usage[commandArgs[0]]}\n`, commandArgs.join(' '));
    }

    const skill = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['skill']);
    assert.equal(skill.code, 0, skill.stderr);
    assert.equal(skill.stdout, await fs.readFile(path.join(root, 'skills', 'pi-dock', 'SKILL.md'), 'utf8'), 'skill prints SKILL.md verbatim');

    const help = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), []);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /AI agents: read the output of pi-dock skill before using pi-dock\. It is the full operating guide,\nalso shipped as the pi-dock Pi skill\.\n$/);
    for (const flag of ['--help', '-h']) {
      const alias = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), [flag]);
      assert.equal(alias.code, 0, alias.stderr);
      assert.equal(alias.stdout, help.stdout, `${flag} matches bare help`);
    }

    const ageCases = [['s', 0, /^\ds$/], ['m', 12.5 * 60, /^12m$/], ['h', 5.5 * 3600, /^5h$/], ['d', 43.5 * 86400, /^43d$/]];
    for (const [suffix, seconds] of ageCases) {
      const ageName = `age-${suffix}-${randomUUID()}`;
      await fs.writeFile(path.join(dock, `${ageName}.json`), `${JSON.stringify({ ...manifest('age'), name: ageName, pipe: pipePath(ageName), startedAt: new Date(Date.now() - seconds * 1000).toISOString() })}\n`);
    }
    await fs.writeFile(path.join(dock, 'z.json'), `${JSON.stringify({ ...manifest('z'), name: 'z', pipe: pipePath('z'), model: 'test/a-much-longer-model-id' })}\n`);
    const agesLs = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['ls']);
    assert.equal(agesLs.code, 0, agesLs.stderr);
    const lsLines = agesLs.stdout.trimEnd().split('\n');
    assert.match(lsLines[0], /^name {2,}state {2,}model {2,}age$/);
    const columnStarts = ['state', 'model', 'age'].map((heading) => lsLines[0].indexOf(heading));
    for (const line of lsLines) {
      assert.equal(line, line.trimEnd(), 'ls trims trailing spaces');
      assert.deepEqual(columnStarts.map((start) => line.slice(start - 2, start + 1).match(/^ {2}\S$/) !== null), [true, true, true], `ls columns aligned: ${line}`);
    }
    assert.equal(stateFromLs(agesLs.stdout, 'z'), 'failed');
    for (const [suffix, , age] of ageCases) {
      const [name, state, model, shown, ...extra] = lsLines.find((line) => line.startsWith(`age-${suffix}-`)).split(/ +/);
      assert.equal(state, 'failed', name);
      assert.equal(model, 'test/model');
      assert.match(shown, age);
      assert.deepEqual(extra, []);
    }

    const observeName = `observe-${randomUUID()}`;
    await fs.writeFile(path.join(dock, `${observeName}.json`), `${JSON.stringify({ ...manifest('observe'), name: observeName, pipe: pipePath(observeName) })}\n`);
    const observeLog = [
      { ts: '2026-01-01T00:00:00.000Z', event: 'spawned', pid: 42 },
      { ts: '2026-01-01T00:00:01.000Z', event: 'turn' },
      { ts: '2026-01-01T00:00:02.000Z', event: 'text', text: 'line "one"\n2026-01-01T00:00:09.000Z idle' },
      { ts: '2026-01-01T00:00:03.000Z', event: 'idle' },
      { ts: '2026-01-01T00:00:04.000Z', event: 'compact_failed', reason: 'Nothing to compact (session too small)' },
      { ts: '2026-01-01T00:00:04.500Z', event: 'failed', reason: 'provider error\n2026-01-01T00:00:09.000Z idle' },
      { ts: '2026-01-01T00:00:05.000Z', event: 'stopped' },
    ].map((event) => `${JSON.stringify(event)}\n`).join('');
    await fs.writeFile(path.join(dock, `${observeName}.log`), `${observeLog}{"ts":"torn`);
    const logs = (...extra) => runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['logs', observeName, ...extra]);
    const rendered = await logs();
    assert.equal(rendered.stdout, [
      '2026-01-01T00:00:00.000Z spawned pid=42',
      '2026-01-01T00:00:01.000Z turn',
      '2026-01-01T00:00:02.000Z text',
      '  line "one"',
      '  2026-01-01T00:00:09.000Z idle',
      '2026-01-01T00:00:03.000Z idle',
      '2026-01-01T00:00:04.000Z compact_failed reason=Nothing to compact (session too small)',
      '2026-01-01T00:00:04.500Z failed reason=provider error',
      '  2026-01-01T00:00:09.000Z idle',
      '2026-01-01T00:00:05.000Z stopped',
      '',
    ].join('\n'), 'default view renders text verbatim and indented under its header');
    assert.equal((await logs('--raw')).stdout, observeLog, 'raw view is the stored complete NDJSON');
    assert.equal((await logs('--raw', '--tail', '4')).stdout, observeLog.split('\n').slice(3).join('\n'), 'tail counts events');
    assert.equal((await logs('--tail', '4')).stdout, rendered.stdout.split('\n').slice(5).join('\n'));
    for (const badTail of ['0', '1.5', 'x']) {
      const result = await logs('--tail', badTail);
      assert.equal(result.code, 1);
      assert.equal(result.stderr, `Option '--tail' must be a positive integer, got '${badTail}'\nusage: ${usage.logs}\n`);
    }
    const show = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['show', observeName]);
    assert.equal(show.code, 0, show.stderr);
    assert.equal(show.stdout, [
      `name ${observeName}`,
      'state stopped',
      'model test/model',
      'thinking -',
      'flags []',
      'cwd cwd-observe',
      'session session-observe',
      'created 2026-01-01T00:00:00Z',
      '',
    ].join('\n'));

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

    const emptySetName = `set-empty-${randomUUID()}`;
    const emptySetFile = await writeSetFixture(dock, emptySetName);
    const beforeEmptySet = await fs.readFile(emptySetFile);
    const emptySpawnName = `spawn-empty-${randomUUID()}`;
    for (const [commandArgs, option] of [
      [['spawn', '--name', emptySpawnName, '--model='], 'model'],
      [['spawn', '--name', emptySpawnName, '--thinking', ''], 'thinking'],
      [['set', emptySetName, '--model='], 'model'],
      [['set', emptySetName, '--model=', '--thinking', 'max'], 'model'],
      [['set', emptySetName, '--thinking='], 'thinking'],
      [['set', emptySetName, '--x', 'a', '--thinking='], 'thinking'],
    ]) {
      assert.deepEqual(await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), commandArgs), {
        code: 1,
        signal: null,
        stdout: '',
        stderr: `Option '--${option}' must not be empty\nusage: ${usage[commandArgs[0]]}\n`,
      }, `${commandArgs.join(' ')} is a usage error`);
    }
    assert.deepEqual(await fs.readFile(emptySetFile), beforeEmptySet, 'an empty value rewrites no manifest');
    for (const extension of ['json', 'log']) {
      await assert.rejects(fs.access(path.join(dock, `${emptySpawnName}.${extension}`)), { code: 'ENOENT' }, 'an empty value launches no agent');
    }

    const absentSetName = `set-absent-${randomUUID()}`;
    const absentSetFile = await writeSetFixture(dock, absentSetName);
    const absentSet = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['set', absentSetName, '--thinking', 'max']);
    assert.equal(absentSet.code, 0, absentSet.stderr);
    assert.equal(JSON.parse(await fs.readFile(absentSetFile, 'utf8')).thinking, 'max', 'affirmative absent pipe permits powered-off set');

    const liveSetName = `set-live-${randomUUID()}`;
    const liveSetFile = await writeSetFixture(dock, liveSetName);
    const liveServer = serve(pipePath(liveSetName), () => ({ ok: true, state: 'idle' }));
    await withOwnedServer(liveServer, new Set(), async () => {
      const beforeLiveSet = await fs.readFile(liveSetFile);
      const liveSet = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['set', liveSetName, '--thinking', 'low']);
      assert.equal(liveSet.code, 1);
      assert.equal(liveSet.stderr.trim(), `agent ${liveSetName} is running — stop it first`);
      assert.deepEqual(await fs.readFile(liveSetFile), beforeLiveSet, 'live pipe refusal preserves manifest bytes');
    });

    const timeoutSetName = `set-timeout-${randomUUID()}`;
    const timeoutSetFile = await writeSetFixture(dock, timeoutSetName);
    const timeoutSockets = new Set();
    let timeoutAccepted = 0;
    const timeoutServer = net.createServer((socket) => {
      timeoutAccepted += 1;
      timeoutSockets.add(socket);
      socket.on('close', () => timeoutSockets.delete(socket));
    });
    timeoutServer.listen(pipePath(timeoutSetName));
    await withOwnedServer(timeoutServer, timeoutSockets, async () => {
      const beforeTimeoutSet = await fs.readFile(timeoutSetFile);
      const timeoutSet = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['set', timeoutSetName, '--thinking', 'low']);
      assert.equal(timeoutSet.code, 1);
      assert.equal(timeoutSet.stderr.trim(), `agent ${timeoutSetName} is not responding`);
      assert(timeoutAccepted >= 1, 'timeout fixture accepted the production request');
      assert.deepEqual(await fs.readFile(timeoutSetFile), beforeTimeoutSet, 'timeout refusal preserves manifest bytes');
      const silentLs = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['ls']);
      assert.equal(silentLs.code, 0, silentLs.stderr);
      assert.equal(stateFromLs(silentLs.stdout, timeoutSetName), 'not-responding', 'ls shows a runner that does not answer in time as not-responding');
      const silentShow = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['show', timeoutSetName]);
      assert.match(silentShow.stdout, /^state not-responding$/m, 'show shows a runner that does not answer in time as not-responding');
    });

    const unknownSetName = `set-unknown-${randomUUID()}`;
    const unknownSetFile = await writeSetFixture(dock, unknownSetName);
    const unknownServer = serve(pipePath(unknownSetName), () => ({ unexpected: true }));
    await withOwnedServer(unknownServer, new Set(), async () => {
      const beforeUnknownSet = await fs.readFile(unknownSetFile);
      const unknownSet = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['set', unknownSetName, '--thinking', 'low']);
      assert.equal(unknownSet.code, 1);
      assert.equal(unknownSet.stderr.trim(), `agent ${unknownSetName} liveness check failed: invalid status reply`);
      assert.deepEqual(await fs.readFile(unknownSetFile), beforeUnknownSet, 'unknown status refusal preserves manifest bytes');
    });

    const malformedSetName = `set-malformed-${randomUUID()}`;
    const malformedSetFile = await writeSetFixture(dock, malformedSetName);
    const malformedSockets = new Set();
    const malformedSentinel = 'MALFORMED_STATUS_PAYLOAD';
    const malformedServer = net.createServer((socket) => {
      malformedSockets.add(socket);
      socket.once('data', () => socket.write(`${malformedSentinel}\n`));
      socket.on('close', () => malformedSockets.delete(socket));
    });
    malformedServer.listen(pipePath(malformedSetName));
    await withOwnedServer(malformedServer, malformedSockets, async () => {
      const beforeMalformedSet = await fs.readFile(malformedSetFile);
      const malformedSet = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['set', malformedSetName, '--thinking', 'low']);
      assert.equal(malformedSet.code, 1);
      assert.equal(malformedSet.stderr.trim(), `agent ${malformedSetName} liveness check failed: invalid status reply`);
      assert.equal(malformedSet.stderr.includes(malformedSentinel), false, 'malformed payload does not leak into diagnostic');
      assert.deepEqual(await fs.readFile(malformedSetFile), beforeMalformedSet, 'malformed status refusal preserves manifest bytes');
      assert.deepEqual(await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['stop', malformedSetName]), { code: 1, signal: null, stdout: '', stderr: `agent ${malformedSetName} Unexpected token 'M', "MALFORMED_"... is not valid JSON\n` }, 'a non-JSON stop reply is a failure, not already stopped');
    });

    const regressModel = { reasoning: false, input: ['text'] };
    await fs.mkdir(path.join(sandbox, 'agent'), { recursive: true });
    await fs.writeFile(path.join(sandbox, 'agent', 'models.json'), JSON.stringify({
      providers: {
        regress: {
          baseUrl: provider.baseUrl,
          api: 'openai-completions',
          apiKey: 'regress',
          models: [
            { ...regressModel, id: 'alpha-2', contextWindow: 1000000, maxTokens: 500 },
            { ...regressModel, id: 'alpha-10', contextWindow: 200000, maxTokens: 8192, reasoning: true, input: ['text', 'image'] },
          ],
        },
      },
    }));
    await fs.writeFile(path.join(sandbox, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } }));
    await fs.mkdir(path.join(sandbox, 'agent', 'extensions'));
    await fs.writeFile(path.join(sandbox, 'agent', 'extensions', 'idle-work.js'), [
      'export default function (pi) {',
      "  pi.registerFlag('idle-work', { type: 'boolean' });",
      "  pi.on('session_start', () => {",
      "    if (pi.getFlag('idle-work')) {",
      "      setTimeout(() => pi.sendUserMessage('idle work'));",
      '    }',
      '  });',
      '}',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(sandbox, 'agent', 'extensions', 'custom-messages.js'), [
      'export default function (pi) {',
      "  pi.registerFlag('custom-messages', { type: 'boolean' });",
      "  const message = (customType) => ({ customType, content: `${customType} body`, display: false });",
      '  let settled = 0;',
      '  let steer = false;',
      '  let boundary = false;',
      "  pi.on('session_start', () => {",
      "    if (pi.getFlag('custom-messages')) {",
      "      setTimeout(() => pi.sendMessage(message('ext-idle'), { triggerTurn: true }));",
      '    }',
      '  });',
      "  pi.on('agent_settled', () => {",
      "    if (pi.getFlag('custom-messages') && ++settled === 1) {",
      "      pi.sendMessage(message('ext-append'));",
      '    }',
      '  });',
      "  pi.on('message_start', (event) => {",
      "    const text = event.message.role === 'user' ? JSON.stringify(event.message.content) : '';",
      "    steer ||= text.includes('steer me');",
      "    boundary ||= text.includes('boundary me');",
      '  });',
      "  pi.on('message_end', (event) => {",
      "    if (steer && event.message.role === 'assistant') {",
      '      steer = false;',
      "      pi.sendMessage(message('ext-steer'), { triggerTurn: true });",
      '    }',
      '  });',
      "  pi.on('agent_before_settle', () => {",
      '    if (boundary) {',
      '      boundary = false;',
      "      return { entries: [{ type: 'custom_message', ...message('ext-boundary') }] };",
      '    }',
      '  });',
      '}',
      '',
    ].join('\n'));
    const cli = path.join(root, 'bin', 'pi-dock.mjs');
    const allRegress = await runOwnedNode(sandbox, cli, ['models', 'regress/']);
    assert.equal(allRegress.code, 0, allRegress.stderr);
    assert.equal(allRegress.stdout, [
      'model             context  max-out  thinking  images',
      'regress/alpha-10  200K     8.2K     yes       yes',
      'regress/alpha-2   1M       500      no        no',
      '',
    ].join('\n'));
    const oneRegress = await runOwnedNode(sandbox, cli, ['models', 'REGRESS/ALPHA-1']);
    assert.deepEqual(oneRegress.stdout.split('\n').slice(1, -1), ['regress/alpha-10  200K     8.2K     yes       yes']);
    const noRegress = await runOwnedNode(sandbox, cli, ['models', 'regress/zzz']);
    assert.equal(noRegress.code, 1);
    assert.equal(noRegress.stderr.trim(), 'no available models match regress/zzz');
    const badThinking = await runOwnedNode(sandbox, cli, ['spawn', '--name', 'thinking-max', '--thinking', 'maximum']);
    assert.equal(badThinking.stderr.trim(), 'invalid thinking level: maximum');
    const hinted = await runOwnedNode(sandbox, cli, ['spawn', '--name', 'thinking-max', '--thinking', 'max', '--model', 'regress/alpha']);
    assert.equal(hinted.code, 1);
    assert.equal(hinted.stderr.trim(), 'preflight failed: model regress/alpha not found (did you mean: regress/alpha-10, regress/alpha-2; see: pi-dock models regress/alpha); no agent was created');
    await assert.rejects(fs.access(path.join(dock, 'thinking-max.json')), { code: 'ENOENT' });

    const closedName = `closed-${randomUUID()}`;
    await writeSetFixture(dock, closedName);
    const closedSockets = new Set();
    let closedAccepted = 0;
    const closedServer = net.createServer((socket) => {
      closedAccepted += 1;
      closedSockets.add(socket);
      socket.once('data', () => socket.destroy());
      socket.on('close', () => closedSockets.delete(socket));
    });
    closedServer.listen(pipePath(closedName));
    await withOwnedServer(closedServer, closedSockets, async () => {
      for (const [commandArgs, cmd] of [[['compact', closedName], 'compact'], [['send', closedName, 'text'], 'prompt'], [['start', closedName], 'status']]) {
        closedAccepted = 0;
        const closed = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), commandArgs);
        assert.equal(closed.code, 1);
        assert.equal(closed.stderr.trim(), `agent ${closedName} stopped or crashed during ${cmd}`);
        assert.equal(closedAccepted, 1, `${cmd} mid-request close is not retried`);
      }
      await assert.rejects(fs.access(path.join(dock, `${closedName}.log`)), { code: 'ENOENT' }, 'mid-request close does not wake a runner');
      assert.deepEqual(await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['stop', closedName]), { code: 1, signal: null, stdout: '', stderr: `agent ${closedName} pipe closed before reply\n` }, 'a stop closed before its reply is a failure, not already stopped');
    });

    const own = (child, name) => {
      ownedRunners.push(child);
      ownedRunnerPipes.set(child, pipePath(name));
      return child;
    };
    const send = async (name, text) => {
      const result = await runOwnedNode(sandbox, cli, ['send', name, text]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^p[0-9a-f]{12}\n$/, 'send prints only the prompt id');
      return result.stdout.trim();
    };
    const wait = (name, id) => runOwnedNode(sandbox, cli, ['wait', name, id]);
    const exited = (code, stdout, stderr) => ({ code, signal: null, stdout, stderr });
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const stop = async (name, child) => {
      assert.equal((await runOwnedNode(sandbox, cli, ['stop', name])).stdout, `${name} stopped\n`);
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'stop returns only after the runner exited');
      await waitForExit(child);
    };
    const corrName = `corr-${randomUUID()}`;
    const corrCwd = path.join(sandbox, 'corr-cwd');
    await fs.mkdir(corrCwd);
    await fs.writeFile(path.join(corrCwd, 'note.txt'), 'note');
    const corr = own(launchRunner(sandbox, ['--name', corrName, '--cwd', corrCwd, '--model', 'regress/alpha-2', '--create']), corrName);
    assert(await waitForStatus(pipePath(corrName)), 'correlation runner starts');

    provider.replies.push(textReply('faux hello'));
    const helloId = await send(corrName, 'hello');
    let logged = await waitForLog(dock, corrName, (all) => all.some((event) => event.event === 'done' && event.id === helloId));
    assert.deepEqual(eventsOf(logged, helloId), [
      { event: 'queued', id: helloId },
      { event: 'run', id: helloId },
      { event: 'turn', id: helloId },
      { event: 'text', id: helloId, text: 'faux hello' },
      { event: 'done', id: helloId },
    ], 'a normal run is correlated from queue to done');
    assert.deepEqual(await wait(corrName, helloId), exited(0, 'faux hello\n', ''), 'wait reports a run that ended before it started');
    assert.deepEqual(await wait(corrName, 'p000000000000'), exited(1, '', 'unknown prompt id: p000000000000\n'));

    provider.replies.push(serverError, serverError);
    const failId = await send(corrName, 'fail');
    logged = await waitForLog(dock, corrName, (all) => all.some((event) => event.id === failId && event.event === 'run_failed'));
    const failRun = eventsOf(logged, failId);
    assert.deepEqual(failRun.map((event) => event.event), ['queued', 'run', 'turn', 'turn', 'run_failed'], 'an exhausted retry ends the run, not the agent');
    assert.match(failRun.at(-1).reason, /500/);
    assert.deepEqual(await wait(corrName, failId), exited(1, '', `prompt ${failId} failed: ${failRun.at(-1).reason}\n`));
    assert.equal((await request(pipePath(corrName), { cmd: 'status' })).state, 'idle', 'a failed run leaves the agent idle and on');

    provider.replies.push(serverError, textReply('recovered'));
    const retried = await runOwnedNode(sandbox, cli, ['send', corrName, '--wait', 'retry']);
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(retried.stdout, 'recovered\n', 'send --wait prints only the final text on stdout');
    assert.match(retried.stderr, /^p[0-9a-f]{12}\n$/, 'send --wait prints the id on stderr');
    const retryId = retried.stderr.trim();
    logged = await logEvents(dock, corrName);
    assert.deepEqual(eventsOf(logged, retryId), [
      { event: 'queued', id: retryId },
      { event: 'run', id: retryId },
      { event: 'turn', id: retryId },
      { event: 'turn', id: retryId },
      { event: 'text', id: retryId, text: 'recovered' },
      { event: 'done', id: retryId },
    ], 'a retried error followed by success is done');

    provider.replies.push(
      sse([{ delta: { content: 'reading', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'note.txt' }) } }] } }, { delta: {}, finish_reason: 'tool_calls' }]),
      sse([{ delta: {}, finish_reason: 'stop' }]),
    );
    const emptyId = await send(corrName, 'read the note');
    logged = await waitForLog(dock, corrName, (all) => all.some((event) => event.id === emptyId && event.event === 'done'));
    assert.deepEqual(eventsOf(logged, emptyId), [
      { event: 'queued', id: emptyId },
      { event: 'run', id: emptyId },
      { event: 'turn', id: emptyId },
      { event: 'text', id: emptyId, text: 'reading' },
      { event: 'turn', id: emptyId },
      { event: 'done', id: emptyId },
    ], 'an empty final turn has no text after its turn event');
    assert.deepEqual(await wait(corrName, emptyId), exited(0, '', ''), 'a done run without final text prints nothing');

    const promptFile = path.join(sandbox, 'prompt.txt');
    await fs.writeFile(promptFile, '-n línea uno\nline two');
    provider.replies.push(textReply('from file'));
    const fromFile = await runOwnedNode(sandbox, cli, ['send', corrName, '--wait', '--file', promptFile]);
    assert.equal(fromFile.stdout, 'from file\n', fromFile.stderr);
    assert.deepEqual(provider.prompts.at(-1), [{ type: 'text', text: '-n línea uno\nline two' }], '--file sends the UTF-8 file contents');
    provider.replies.push(textReply('dashes'));
    const dashed = await runOwnedNode(sandbox, cli, ['send', corrName, '--wait', '--', '--wait', '-x', 'text']);
    assert.equal(dashed.stdout, 'dashes\n', dashed.stderr);
    assert.deepEqual(provider.prompts.at(-1), [{ type: 'text', text: '--wait -x text' }], '-- ends options');

    const corrHold = held(textReply('late'));
    provider.replies.push(corrHold.reply);
    const stopIds = [await send(corrName, 'one'), await send(corrName, 'two'), await send(corrName, 'three')];
    await corrHold.arrived;
    const stopWaits = stopIds.slice(0, 2).map((id) => wait(corrName, id));
    await pause(1000);
    await stop(corrName, corr);
    assert.deepEqual(withoutTimes(await logEvents(dock, corrName)).slice(-2), [
      { event: 'dropped', ids: stopIds.slice(1) },
      { event: 'stopped', id: stopIds[0] },
    ], 'stop lists the queued ids as dropped and names the interrupted run');
    assert.deepEqual(await Promise.all(stopWaits), [
      exited(1, '', `agent ${corrName} stopped during prompt ${stopIds[0]}\n`),
      exited(1, '', `prompt ${stopIds[1]} was dropped before it ran\n`),
    ], 'waits end when the agent stops mid-wait');

    const crashHold = held(textReply('never sent'));
    provider.replies.push(crashHold.reply);
    const crashing = own(launchRunner(sandbox, ['--name', corrName]), corrName);
    assert(await waitForStatus(pipePath(corrName)), 'correlation runner wakes');
    const crashId = await send(corrName, 'crash');
    await crashHold.arrived;
    const crashWait = wait(corrName, crashId);
    await pause(1000);
    crashing.kill();
    await waitForExit(crashing);
    const lost = exited(1, '', `agent ${corrName} stopped or crashed before prompt ${crashId} finished\n`);
    assert.deepEqual(await crashWait, lost, 'a crash mid-wait is reported');
    await assert.rejects(request(pipePath(corrName), { cmd: 'status' }), { code: 'ENOENT' }, 'wait does not wake a crashed agent');
    const restarted = own(launchRunner(sandbox, ['--name', corrName]), corrName);
    assert(await waitForStatus(pipePath(corrName)), 'correlation runner restarts');
    assert.deepEqual(await wait(corrName, crashId), lost, 'a restart after the crash does not leave wait polling');
    await stop(corrName, restarted);
    const setAfterStop = await runOwnedNode(sandbox, cli, ['set', corrName, '--x', 'after-stop']);
    assert.equal(setAfterStop.code, 0, `set right after stop finds the pipe gone: ${setAfterStop.stderr}`);

    const idleName = `idle-${randomUUID()}`;
    const idleHold = held(textReply('idle reply'));
    provider.replies.push(idleHold.reply);
    const idle = own(launchRunner(sandbox, ['--name', idleName, '--cwd', corrCwd, '--model', 'regress/alpha-2', '--x', 'idle-work', '--create']), idleName);
    await idleHold.arrived;
    const pipeId = await send(idleName, 'pipe work');
    provider.replies.push(textReply('pipe reply'));
    assert.deepEqual(withoutTimes(await logEvents(dock, idleName)), [{ event: 'turn' }, { event: 'queued', id: pipeId }], 'the pipe prompt waits while idle extension work runs');
    idleHold.release();
    logged = await waitForLog(dock, idleName, (all) => all.some((event) => event.id === pipeId && event.event === 'done'));
    assert.deepEqual(withoutTimes(logged), [
      { event: 'turn' },
      { event: 'queued', id: pipeId },
      { event: 'text', text: 'idle reply' },
      { event: 'run', id: pipeId },
      { event: 'turn', id: pipeId },
      { event: 'text', id: pipeId, text: 'pipe reply' },
      { event: 'done', id: pipeId },
    ], 'idle extension work stays id-less and the pipe run starts after it settles');
    await stop(idleName, idle);

    const wokenHold = held(textReply('never sent'));
    provider.replies.push(wokenHold.reply);
    const woken = own(launchRunner(sandbox, ['--name', idleName]), idleName);
    await wokenHold.arrived;
    const waitingId = await send(idleName, 'waiting work');
    await stop(idleName, woken);
    logged = await logEvents(dock, idleName);
    assert.deepEqual(withoutTimes(logged.slice(logged.findLastIndex((event) => event.event === 'spawned'))), [
      { event: 'turn' },
      { event: 'queued', id: waitingId },
      { event: 'dropped', ids: [waitingId] },
      { event: 'stopped' },
    ], 'a stop while waiting for idle drops the pipe prompt instead of interrupting it');

    const multiName = `multi-${randomUUID()}`;
    const multi = own(launchRunner(sandbox, ['--name', multiName, '--cwd', corrCwd, '--model', 'regress/alpha-2', '--create']), multiName);
    const corrWoken = own(launchRunner(sandbox, ['--name', corrName]), corrName);
    assert(await waitForStatus(pipePath(multiName)), 'multi-stop runner starts');
    assert(await waitForStatus(pipePath(corrName)), 'correlation runner wakes for a multi-name stop');
    const absentStopName = `stop-absent-${randomUUID()}`;
    for (const [names, stderr] of [
      [[corrName, '../bad', multiName], 'invalid agent name: ../bad\n'],
      [[corrName, multiName, corrName], `duplicate agent name: ${corrName}\n`],
      [[corrName, absentStopName, multiName], `no such agent: ${absentStopName}\n`],
    ]) {
      assert.deepEqual(await runOwnedNode(sandbox, cli, ['stop', ...names]), exited(1, '', stderr), `stop ${names.join(' ')} rejects the whole list`);
    }
    for (const name of [corrName, multiName]) {
      assert.equal((await request(pipePath(name), { cmd: 'status' })).ok, true, 'a rejected stop list stops nothing');
    }
    const lingeringName = `stop-lingering-${randomUUID()}`;
    await writeSetFixture(dock, lingeringName);
    const lingeringServer = serve(pipePath(lingeringName), () => ({ ok: true, pid: process.pid }));
    const badPidName = `stop-bad-pid-${randomUUID()}`;
    await writeSetFixture(dock, badPidName);
    const badPidServer = serve(pipePath(badPidName), () => ({ ok: true, pid: 'nope' }));
    await withOwnedServer(lingeringServer, new Set(), () => withOwnedServer(badPidServer, new Set(), async () => {
      assert.deepEqual(await runOwnedNode(sandbox, cli, ['stop', badPidName, lingeringName, corrName, multiName, idleName]), exited(
        1,
        `${corrName} stopped\n${multiName} stopped\n${idleName} already stopped\n`,
        `agent ${badPidName} The "pid" argument must be of type number. Received type string ('nope')\n`
          + `agent ${lingeringName} did not exit within 5s; terminate PID ${process.pid} externally\n`,
      ), 'stop names every failed agent, continues past failures and exits 1');
    }));
    for (const child of [corrWoken, multi]) {
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'a multi-name stop returns only after its runners exited');
      await waitForExit(child);
    }
    const extName = `ext-${randomUUID()}`;
    provider.replies.push(textReply('idle custom reply'));
    const ext = own(launchRunner(sandbox, ['--name', extName, '--cwd', corrCwd, '--model', 'regress/alpha-2', '--x', 'custom-messages', '--create']), extName);
    assert(await waitForStatus(pipePath(extName)), 'custom-message runner starts');
    logged = await waitForLog(dock, extName, (all) => all.some((event) => event.type === 'ext-append'));
    assert.deepEqual(withoutTimes(logged), [
      { event: 'turn' },
      { event: 'external', type: 'ext-idle' },
      { event: 'text', text: 'idle custom reply' },
      { event: 'external', type: 'ext-append' },
    ], 'idle custom messages log external without an id, with or without a turn');
    provider.replies.push(textReply('before steer'), textReply('after steer'));
    const steerId = await send(extName, 'steer me');
    assert.deepEqual(await wait(extName, steerId), exited(0, 'after steer\n', ''), 'a steered custom message keeps the final text');
    provider.replies.push(textReply('boundary reply'));
    const boundaryId = await send(extName, 'boundary me');
    assert.deepEqual(await wait(extName, boundaryId), exited(0, 'boundary reply\n', ''), 'a boundary entry after the last text keeps the final text');
    logged = await logEvents(dock, extName);
    assert.deepEqual(eventsOf(logged, steerId), [
      { event: 'queued', id: steerId },
      { event: 'run', id: steerId },
      { event: 'turn', id: steerId },
      { event: 'text', id: steerId, text: 'before steer' },
      { event: 'turn', id: steerId },
      { event: 'external', id: steerId, type: 'ext-steer' },
      { event: 'text', id: steerId, text: 'after steer' },
      { event: 'done', id: steerId },
    ], 'a custom message steered into a pipe run logs external once, with the run id');
    assert.deepEqual(eventsOf(logged, boundaryId), [
      { event: 'queued', id: boundaryId },
      { event: 'run', id: boundaryId },
      { event: 'turn', id: boundaryId },
      { event: 'text', id: boundaryId, text: 'boundary reply' },
      { event: 'external', id: boundaryId, type: 'ext-boundary' },
      { event: 'done', id: boundaryId },
    ], 'a boundary custom_message entry logs external exactly once');
    await stop(extName, ext);

    const ghostName = `ghost-${randomUUID()}`;
    const ghostManifest = path.join(dock, `${ghostName}.json`);
    const ghost = own(launchRunner(sandbox, ['--name', ghostName, '--cwd', corrCwd, '--model', 'regress/alpha-2']), ghostName);
    assert.deepEqual(await waitForExit(ghost), { code: 1, signal: null }, 'a wake without a manifest fails');
    assert.deepEqual((await logEvents(dock, ghostName)).map(({ ts: _ts, ...event }) => event), [
      { event: 'failed', reason: `ENOENT: no such file or directory, open '${ghostManifest}'` },
    ], 'the failed wake logs the missing manifest');
    await assert.rejects(fs.access(ghostManifest), { code: 'ENOENT' }, 'a failed wake creates no manifest');

    // A project extension that records each load and session_start with the runner's PID, and
    // holds startup in session_start while the hold file exists.
    const singleName = `single-${randomUUID()}`;
    const singleCwd = path.join(sandbox, 'single-cwd');
    const startups = path.join(singleCwd, 'startups.log');
    const hold = path.join(singleCwd, 'hold');
    await fs.mkdir(path.join(singleCwd, '.pi', 'extensions'), { recursive: true });
    await fs.writeFile(path.join(singleCwd, '.pi', 'extensions', 'startups.js'), [
      "import { appendFileSync, existsSync } from 'node:fs';",
      `const record = (event) => appendFileSync(${JSON.stringify(startups)}, \`\${event} \${process.pid}\\n\`);`,
      'export default function (pi) {',
      "  record('load');",
      "  pi.on('session_start', async () => {",
      "    record('session_start');",
      `    while (existsSync(${JSON.stringify(hold)})) {`,
      '      await new Promise((resolve) => setTimeout(resolve, 50));',
      '    }',
      '  });',
      '}',
      '',
    ].join('\n'));
    const startupsOf = async (pid, message) => {
      assert.deepEqual((await fs.readFile(startups, 'utf8')).trim().split('\n'), [`load ${pid}`, `session_start ${pid}`], message);
      await fs.rm(startups);
    };
    const created = own(launchRunner(sandbox, ['--name', singleName, '--cwd', singleCwd, '--model', 'regress/alpha-2', '--create']), singleName);
    assert(await waitForStatus(pipePath(singleName)), 'single runner starts');
    await startupsOf(created.pid, 'the created runner loads its extensions once');
    await stop(singleName, created);

    let since = (await logEvents(dock, singleName)).length;
    const starts = await Promise.all([1, 2].map(() => runOwnedNode(sandbox, cli, ['start', singleName])));
    try {
      assert.deepEqual(starts, [1, 2].map(() => exited(0, `${singleName} idle regress/alpha-2\n`, '')), 'two concurrent starts both report the agent');
      const { pid } = await request(pipePath(singleName), { cmd: 'status' });
      await startupsOf(pid, 'two concurrent starts load extensions only in the runner that serves');
      assert.deepEqual((await logEvents(dock, singleName)).slice(since).map((event) => [event.event, event.pid]), [['spawned', pid]], 'one runner starts and nothing fails');
      assert.deepEqual(await runOwnedNode(sandbox, cli, ['start', singleName]), exited(0, `${singleName} idle regress/alpha-2\n`, ''), 'start on a running agent prints its state');
      assert.equal((await logEvents(dock, singleName)).length, since + 1, 'start on a running agent does not wake another runner');
    } finally {
      assert.equal((await runOwnedNode(sandbox, cli, ['stop', singleName])).stdout, `${singleName} stopped\n`);
    }

    since = (await logEvents(dock, singleName)).length;
    await fs.writeFile(hold, '');
    const pair = [1, 2].map(() => own(launchRunner(sandbox, ['--name', singleName]), singleName));
    for (let tries = 0; !(await fs.readFile(startups, 'utf8').catch(() => '')).includes('session_start'); tries += 1) {
      assert(tries < 300, 'a runner reaches session_start');
      await pause(50);
    }
    const early = request(pipePath(singleName), { cmd: 'status' }, null);
    assert.equal(await Promise.race([early.then(() => 'answered'), pause(1000).then(() => 'waiting')]), 'waiting', 'a status request during startup waits instead of answering');
    const heldPid = Number((await fs.readFile(startups, 'utf8')).match(/session_start (\d+)/)[1]);
    assert.deepEqual((await logEvents(dock, singleName)).slice(since).map((event) => [event.event, event.pid]), [['spawned', heldPid]], 'spawned names the owner while its startup is still running');
    await fs.rm(hold);
    const { ok, pid: ownerPid } = await early;
    assert.equal(ok, true, 'the waiting status request is answered once the agent is ready');
    const [owner, loser] = pair[0].pid === ownerPid ? pair : [pair[1], pair[0]];
    assert.equal(owner.pid, ownerPid, 'one of the two runners owns the agent');
    assert.deepEqual(await waitForExit(loser), { code: 0, signal: null }, 'the runner that loses the pipe exits quietly');
    await startupsOf(ownerPid, 'of two runners launched together, only the pipe owner loads extensions');
    assert.deepEqual((await logEvents(dock, singleName)).slice(since).map((event) => [event.event, event.pid]), [['spawned', ownerPid]], 'the loser writes nothing to the log');
    await stop(singleName, owner);

    // A runner shutting down answers terminal: start wakes a new one once the pipe is free.
    const shuttingDown = serve(pipePath(singleName), () => {
      setImmediate(() => shuttingDown.close());
      return { ok: false, error: 'terminal' };
    });
    await waitForServer(shuttingDown);
    since = (await logEvents(dock, singleName)).length;
    try {
      assert.deepEqual(await runOwnedNode(sandbox, cli, ['start', singleName]), exited(0, `${singleName} idle regress/alpha-2\n`, ''), 'start wakes an agent whose runner answers terminal');
      const { pid } = await request(pipePath(singleName), { cmd: 'status' });
      assert.deepEqual((await logEvents(dock, singleName)).slice(since).map((event) => [event.event, event.pid]), [['spawned', pid]], 'the terminal reply woke one new runner');
    } finally {
      assert.equal((await runOwnedNode(sandbox, cli, ['stop', singleName])).stdout, `${singleName} stopped\n`);
    }

    const busyName = `start-busy-${randomUUID()}`;
    await writeSetFixture(dock, busyName);
    const busyServer = serve(pipePath(busyName), () => ({ ok: false, error: 'busy' }));
    await withOwnedServer(busyServer, new Set(), async () => {
      assert.deepEqual(await runOwnedNode(sandbox, cli, ['start', busyName]), exited(1, '', `agent ${busyName} refused status: {"ok":false,"error":"busy"}\n`), 'start fails on a non-terminal refusal instead of waking');
    });

    // A project extension that compacts when the trigger file appears and, for compactions with
    // the instructions 'hold', holds session_before_compact while the hold file exists and the
    // compaction is not aborted, then supplies a local summary (no LLM). It also holds
    // session_compact_failed while the hold file exists, then throws. keepRecentTokens 1 leaves
    // earlier turns to summarize.
    const compactName = `compact-${randomUUID()}`;
    const compactCwd = path.join(sandbox, 'compact-cwd');
    const compactRecord = path.join(compactCwd, 'compactions.log');
    const compactTrigger = path.join(compactCwd, 'trigger');
    const compactHold = path.join(compactCwd, 'hold');
    await fs.mkdir(path.join(compactCwd, '.pi', 'extensions'), { recursive: true });
    await fs.writeFile(path.join(compactCwd, '.pi', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
    await fs.writeFile(path.join(compactCwd, '.pi', 'extensions', 'compactor.js'), [
      "import { appendFileSync, existsSync, rmSync } from 'node:fs';",
      `const record = (line) => appendFileSync(${JSON.stringify(compactRecord)}, \`\${line}\\n\`);`,
      'export default function (pi) {',
      "  pi.on('session_start', (_event, ctx) => {",
      '    setInterval(() => {',
      `      if (existsSync(${JSON.stringify(compactTrigger)})) {`,
      `        rmSync(${JSON.stringify(compactTrigger)});`,
      "        ctx.compact({ customInstructions: 'hold', onComplete: () => record('completed'), onError: (error) => record(`failed ${error.message}`) });",
      '      }',
      '    }, 50).unref();',
      '  });',
      "  pi.on('session_before_compact', async ({ preparation, customInstructions, signal }) => {",
      '    record(`before_compact ${customInstructions}`);',
      `    while (customInstructions === 'hold' && existsSync(${JSON.stringify(compactHold)}) && !signal.aborted) {`,
      '      await new Promise((resolve) => setTimeout(resolve, 50));',
      '    }',
      "    return { compaction: { summary: 'local summary', firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore } };",
      '  });',
      "  pi.on('session_compact_failed', async ({ errorMessage }) => {",
      '    record(`compact_failed ${errorMessage}`);',
      `    while (existsSync(${JSON.stringify(compactHold)})) {`,
      '      await new Promise((resolve) => setTimeout(resolve, 50));',
      '    }',
      "    throw new Error('failure hook broke');",
      '  });',
      '}',
      '',
    ].join('\n'));
    const recorded = async (expected) => {
      for (const deadline = Date.now() + 15000; Date.now() < deadline; await pause(50)) {
        const lines = (await fs.readFile(compactRecord, 'utf8').catch(() => '')).trim().split('\n');
        if (lines.at(-1) === expected) {
          return lines;
        }
      }
      throw new Error(`compactor did not record ${expected}`);
    };
    const compactor = own(launchRunner(sandbox, ['--name', compactName, '--cwd', compactCwd, '--model', 'regress/alpha-2', '--create']), compactName);
    assert(await waitForStatus(pipePath(compactName)), 'compactor runner starts');
    for (const reply of ['first', 'second']) {
      provider.replies.push(textReply(reply));
      assert.equal((await wait(compactName, await send(compactName, reply))).stdout, `${reply}\n`);
    }

    await fs.writeFile(compactHold, '');
    await fs.writeFile(compactTrigger, '');
    await recorded('before_compact hold');
    since = (await logEvents(dock, compactName)).length;
    assert.equal((await request(pipePath(compactName), { cmd: 'status' })).state, 'compacting', 'status reports a compaction an extension started on an idle agent');
    assert.deepEqual(await runOwnedNode(sandbox, cli, ['compact', compactName]), exited(1, '', `agent ${compactName} is busy\n`), 'compact is busy during an extension compaction');
    await fs.rm(compactHold);
    assert.deepEqual(await recorded('completed'), ['before_compact hold', 'completed'], 'the extension compaction completes uncancelled');
    assert.deepEqual((await logEvents(dock, compactName)).slice(since), [], 'the refused compact started no compaction');

    provider.replies.push(textReply('third'));
    assert.equal((await wait(compactName, await send(compactName, 'third'))).stdout, 'third\n');
    await fs.writeFile(compactHold, '');
    const heldCompact = runOwnedNode(sandbox, cli, ['compact', compactName, 'hold']);
    await recorded('before_compact hold');
    assert.equal((await request(pipePath(compactName), { cmd: 'status' })).state, 'compacting', 'status reports a compaction the CLI started');
    await fs.rm(compactHold);
    assert.deepEqual(await heldCompact, exited(0, 'compacted\n', ''), 'the CLI compaction completes');

    // The SDK reports no compaction while its failure hooks run, but the CLI's compact is pending.
    await fs.writeFile(compactHold, '');
    const failingCompact = runOwnedNode(sandbox, cli, ['compact', compactName]);
    await recorded('compact_failed Compaction failed: Already compacted');
    assert.equal((await request(pipePath(compactName), { cmd: 'status' })).state, 'compacting', 'status reports a CLI compaction until it settles');
    // Bounded, because a compact accepted here would wait behind the held one.
    assert.deepEqual(await request(pipePath(compactName), { cmd: 'compact' }, 5000), { ok: false, error: 'busy' }, 'compact is busy until the pending CLI compaction settles');
    await fs.rm(compactHold);
    assert.deepEqual(await failingCompact, exited(1, '', 'Already compacted\n'), 'the pending CLI compaction fails with its reason');

    // Stop while a failure hook is held: the runner logs stopped and waits for the pending
    // compact; the hook then throws, and nothing may follow the terminal event.
    await fs.writeFile(compactHold, '');
    await fs.rm(compactRecord);
    const lateCompact = runOwnedNode(sandbox, cli, ['compact', compactName]);
    await recorded('compact_failed Compaction failed: Already compacted');
    const stopping = runOwnedNode(sandbox, cli, ['stop', compactName]);
    await waitForLog(dock, compactName, (all) => all.at(-1).event === 'stopped');
    await fs.rm(compactHold);
    assert.deepEqual(await stopping, exited(0, `${compactName} stopped\n`, ''));
    assert.deepEqual(await lateCompact, exited(1, '', 'Already compacted\n'), 'the compact pending at stop still gets its reply');
    await waitForExit(compactor);
    assert.equal((await logEvents(dock, compactName)).at(-1).event, 'stopped', 'an extension error during shutdown does not follow the terminal event');
    assert.equal(stateFromLs((await runOwnedNode(sandbox, cli, ['ls'])).stdout, compactName), 'stopped', 'ls still shows the agent stopped');
    assert.match((await runOwnedNode(sandbox, cli, ['show', compactName])).stdout, /^state stopped$/m, 'show still shows the agent stopped');

    // A compact whose outcome cannot be logged fails the runner, which must still exit.
    const compactLog = path.join(dock, `${compactName}.log`);
    const uncompacted = own(launchRunner(sandbox, ['--name', compactName]), compactName);
    assert(await waitForStatus(pipePath(compactName)), 'compactor runner wakes');
    await fs.chmod(compactLog, 0o444);
    try {
      await request(pipePath(compactName), { cmd: 'compact' }, 5000).catch(() => {});
      assert.deepEqual(await waitForExit(uncompacted), { code: 1, signal: null }, 'a runner that cannot log a compaction exits');
    } finally {
      await fs.chmod(compactLog, 0o644);
    }

    // A project extension whose session_start and turn_start handlers throw.
    const throwsName = `throws-${randomUUID()}`;
    const throwsCwd = path.join(sandbox, 'throws-cwd');
    const throwsExtension = path.join(throwsCwd, '.pi', 'extensions', 'throws.js');
    await fs.mkdir(path.dirname(throwsExtension), { recursive: true });
    await fs.writeFile(throwsExtension, [
      'export default function (pi) {',
      "  pi.on('session_start', () => { throw new Error('start broke'); });",
      "  pi.on('turn_start', () => { throw new Error('turn broke'); });",
      '}',
      '',
    ].join('\n'));
    const throwsCreated = own(launchRunner(sandbox, ['--name', throwsName, '--cwd', throwsCwd, '--model', 'regress/alpha-2', '--create']), throwsName);
    assert(await waitForStatus(pipePath(throwsName)), 'a runner whose extension throws starts');
    await stop(throwsName, throwsCreated);
    since = (await logEvents(dock, throwsName)).length;
    try {
      assert.deepEqual(await runOwnedNode(sandbox, cli, ['start', throwsName]), exited(0, `${throwsName} idle regress/alpha-2\n`, ''), 'start succeeds although a session_start handler throws');
      provider.replies.push(textReply('still works'));
      const throwsId = await send(throwsName, 'hello');
      assert.equal((await wait(throwsName, throwsId)).stdout, 'still works\n', 'a throwing turn_start handler does not stop the run');
      assert.deepEqual(withoutTimes((await logEvents(dock, throwsName)).slice(since)), [
        { event: 'extension_error', extension: throwsExtension, on: 'session_start', reason: 'start broke' },
        { event: 'queued', id: throwsId },
        { event: 'run', id: throwsId },
        { event: 'extension_error', id: throwsId, extension: throwsExtension, on: 'turn_start', reason: 'turn broke' },
        { event: 'turn', id: throwsId },
        { event: 'text', id: throwsId, text: 'still works' },
        { event: 'done', id: throwsId },
      ], 'extension handler errors are logged, with the prompt id during a run');
      const throwsLogs = (await runOwnedNode(sandbox, cli, ['logs', throwsName])).stdout.split('\n');
      assert(throwsLogs.some((line) => line.endsWith(` extension_error extension=${throwsExtension} on=session_start reason=start broke`)), 'logs renders an extension error on one line');
    } finally {
      assert.equal((await runOwnedNode(sandbox, cli, ['stop', throwsName])).stdout, `${throwsName} stopped\n`);
    }

    // A log that can no longer be written fails the runner's own failure path too: the runner
    // must still exit rather than linger with its queue stalled.
    const unloggedName = `unlogged-${randomUUID()}`;
    const unlogged = own(launchRunner(sandbox, ['--name', unloggedName, '--cwd', corrCwd, '--model', 'regress/alpha-2', '--create']), unloggedName);
    assert(await waitForStatus(pipePath(unloggedName)), 'unlogged runner starts');
    const unloggedLog = path.join(dock, `${unloggedName}.log`);
    await fs.chmod(unloggedLog, 0o444);
    try {
      const refused = { ok: false, error: `EPERM: operation not permitted, open '${unloggedLog}'` };
      assert.deepEqual(await runOwnedNode(sandbox, cli, ['send', unloggedName, 'unqueued']), exited(1, '', `${JSON.stringify(refused)}\n`), 'a prompt whose queued event cannot be logged is refused');
    } finally {
      await fs.chmod(unloggedLog, 0o644);
    }
    assert.deepEqual(await request(pipePath(unloggedName), { cmd: 'compact' }), { ok: false, error: 'Nothing to compact (session too small)' }, 'a refused prompt leaves nothing queued');
    const unloggedHold = held(textReply('unlogged'));
    provider.replies.push(unloggedHold.reply);
    await send(unloggedName, 'first');
    await unloggedHold.arrived;
    await send(unloggedName, 'second');
    await fs.chmod(unloggedLog, 0o444);
    try {
      unloggedHold.release();
      assert.deepEqual(await waitForExit(unlogged), { code: 1, signal: null }, 'a runner that cannot write its log exits');
    } finally {
      await fs.chmod(unloggedLog, 0o644);
    }

    // A wake drops a torn final line (a write cut short) and leaves a clean log untouched.
    const tornName = `torn-${randomUUID()}`;
    const tornLog = path.join(dock, `${tornName}.log`);
    const torn = own(launchRunner(sandbox, ['--name', tornName, '--cwd', corrCwd, '--model', 'regress/alpha-2', '--create']), tornName);
    assert(await waitForStatus(pipePath(tornName)), 'torn runner starts');
    provider.replies.push(textReply('old result'));
    const tornId = await send(tornName, 'before the tear');
    assert.equal((await wait(tornName, tornId)).stdout, 'old result\n');
    await stop(tornName, torn);
    const wakeOnto = async (body, message) => {
      await fs.writeFile(tornLog, body);
      try {
        assert.deepEqual(await runOwnedNode(sandbox, cli, ['start', tornName]), exited(0, `${tornName} idle regress/alpha-2\n`, ''));
        const { pid } = await request(pipePath(tornName), { cmd: 'status' });
        const woken = await fs.readFile(tornLog, 'utf8');
        const clean = body.slice(0, body.lastIndexOf('\n') + 1);
        assert.equal(woken.slice(0, clean.length), clean, message);
        assert.deepEqual(woken.slice(clean.length).trim().split('\n').map(JSON.parse).map(({ ts: _ts, ...event }) => event), [{ event: 'spawned', pid }], `${message}: spawned follows on its own line`);
      } finally {
        assert.equal((await runOwnedNode(sandbox, cli, ['stop', tornName])).stdout, `${tornName} stopped\n`);
      }
    };
    const tornHistory = await fs.readFile(tornLog, 'utf8');
    await wakeOnto(`${tornHistory}{"ts":"torn`, 'a wake drops the torn final line and keeps every complete line');
    assert.deepEqual(await wait(tornName, tornId), exited(0, 'old result\n', ''), 'wait still reads an earlier result after a torn line');
    await wakeOnto(await fs.readFile(tornLog, 'utf8'), 'a wake leaves a clean log byte-identical');
    await wakeOnto('{"ts":"torn', 'a log that is only a torn line is emptied');

    assert.equal(provider.unexpected(), 0, 'the faux provider received only scripted requests');

    const runnerName = `t1-${randomUUID()}`;
    const runnerCwd = path.join(sandbox, 'trusted-empty-cwd');
    await fs.mkdir(runnerCwd);
    const fixtures = Array.from({ length: 6 }, (_, index) => `fixture-${index}`);
    const runners = fixtures.map((fixture) => launchRunner(sandbox, ['--name', runnerName, '--cwd', runnerCwd, '--model', 'anthropic/claude-haiku-4-5', '--x', fixture, '--create']));
    const pipe = pipePath(runnerName);
    for (const child of runners) {
      ownedRunners.push(child);
      ownedRunnerPipes.set(child, pipe);
    }
    const status = await waitForStatus(pipe);
    assert(status, 'one real create runner reaches its owned pipe');
    assert.equal(status.model, 'anthropic/claude-haiku-4-5', 'status reports the resolved model');
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
    const compactResult = await runOwnedNode(sandbox, path.join(root, 'bin', 'pi-dock.mjs'), ['compact', runnerName]);
    assert.equal(compactResult.code, 1);
    assert.equal(compactResult.stderr.trim(), 'Nothing to compact (session too small)');
    const compactEvents = (await fs.readFile(path.join(dock, `${runnerName}.log`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(compactEvents.at(-1), { ts: compactEvents.at(-1).ts, event: 'compact_failed', reason: 'Nothing to compact (session too small)' });
    assert.equal((await request(pipe, { cmd: 'status' })).state, 'idle', 'failed compaction leaves the agent idle and on');
    await stopOwnedRunner(runners[winnerIndex], pipe);

    console.log('regression: 73 cases passed');
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  provider.server.closeAllConnections();
  provider.server.close();
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
