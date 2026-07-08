#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listManifests, readManifest } from '../src/manifest.mjs';
import { logPath, manifestPath } from '../src/paths.mjs';
import { PIPE_REQUEST_TIMEOUT_MS, request } from '../src/pipe.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, 'src', 'runner.mjs');
const command = process.argv[2];
const args = process.argv.slice(3);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function manifestExists(name) {
  try {
    await access(manifestPath(name));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function requireManifest(name) {
  try {
    return await readManifest(name);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`no such agent: ${name}`);
    }
    throw error;
  }
}

function isTimeout(error) {
  return error?.code === 'ETIMEDOUT';
}

function failNotResponding(name) {
  fail(`agent ${name} is not responding`);
}

async function tryStatus(manifest, timeoutMs = 200) {
  try {
    const reply = await request(manifest.pipe, { cmd: 'status' }, timeoutMs);
    if (reply.ok) {
      return reply;
    }
  } catch {}

  return null;
}

function launchRunner(name, options = {}) {
  const argv = [runner, '--name', name];

  if (options.cwd) {
    argv.push('--cwd', options.cwd);
  }
  if (options.model) {
    argv.push('--model', options.model);
  }
  if (options.budget) {
    argv.push('--budget', options.budget);
  }
  for (const flag of options.flags ?? []) {
    argv.push('--x', flag);
  }

  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function handshake(name, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const manifest = await readManifest(name).catch(() => null);
    if (manifest) {
      const status = await tryStatus(manifest, 250);
      if (status) {
        return { manifest, status };
      }
    }
    await sleep(250);
  }

  return null;
}

function lastLogLine(name) {
  const file = logPath(name);
  if (!existsSync(file)) {
    return null;
  }

  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  return lines.at(-1) ?? null;
}

function reportHandshakeFailure(name) {
  console.error(`handshake failed for ${name}`);
  console.error(`manifest: ${manifestPath(name)} ${existsSync(manifestPath(name)) ? 'exists' : 'missing'}`);
  console.error(`log: ${logPath(name)} ${existsSync(logPath(name)) ? 'exists' : 'missing'}`);
  const line = lastLogLine(name);
  if (line) {
    console.error(`last log: ${line}`);
  }
}

let sdkPromise;

async function loadSdk() {
  sdkPromise ??= import('@earendil-works/pi-coding-agent');
  return sdkPromise;
}

async function verifyModelAuth(modelRegistry, model) {
  const available = await modelRegistry.getAvailable();
  const configured = available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
  if (!configured) {
    throw new Error(`no usable credentials for ${model.provider}/${model.id}`);
  }

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }
}

async function preflightSpawn(cwd, modelSpec) {
  const {
    AuthStorage,
    createAgentSession,
    ModelRegistry,
    SessionManager,
  } = await loadSdk();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  if (modelSpec) {
    const slash = modelSpec.indexOf('/');
    const model = slash === -1 ? null : modelRegistry.find(modelSpec.slice(0, slash), modelSpec.slice(slash + 1));
    if (!model) {
      throw new Error(`model ${modelSpec} not found`);
    }

    await verifyModelAuth(modelRegistry, model);
    return;
  }

  let session;
  try {
    ({ session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      authStorage,
      modelRegistry,
    }));

    if (!session.model) {
      throw new Error('no model with usable credentials available');
    }

    await verifyModelAuth(modelRegistry, session.model);
  } finally {
    session?.dispose();
  }
}

function lastCompleteLogEvent(name) {
  const file = logPath(name);

  if (!existsSync(file)) {
    return null;
  }

  const body = readFileSync(file, 'utf8');
  if (!body.endsWith('\n')) {
    return null;
  }

  const lines = body.slice(0, -1).split('\n');
  const line = lines.at(-1);
  if (!line) {
    return null;
  }

  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function stateFromLog(name) {
  const event = lastCompleteLogEvent(name);
  if (event?.event === 'stopped' || event?.event === 'failed') {
    return event.event;
  }

  return 'failed';
}

function formatElapsed(startedAt) {
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms)) {
    return '-';
  }

  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

function formatLogLine(line) {
  try {
    const { ts = '-', event = '-', ...payload } = JSON.parse(line);
    const suffix = Object.keys(payload).length === 0 ? '' : ` ${JSON.stringify(payload)}`;
    return `${ts} ${event}${suffix}`;
  } catch {
    return line;
  }
}

async function spawnCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      model: { type: 'string' },
      budget: { type: 'string' },
      x: { type: 'string', multiple: true },
    },
  });

  const name = values.name;
  if (!name || positionals.length > 0) {
    fail('usage: pi-dock spawn --name <name> [--model <provider/id>] [--budget <turns>[,<minutes>]] [--x key[=value]]...');
  }

  if (await manifestExists(name)) {
    fail(`agent already exists: ${name}`);
  }

  const cwd = process.cwd();
  try {
    await preflightSpawn(cwd, values.model);
  } catch (error) {
    fail(`preflight failed: ${error.message}; no agent was created`);
  }

  launchRunner(name, { cwd, model: values.model, budget: values.budget, flags: values.x });

  const result = await handshake(name);
  if (!result) {
    reportHandshakeFailure(name);
    process.exit(1);
  }

  console.log(`${name} ${result.status.state}`);
}

async function sendPrompt(manifest, text) {
  return request(manifest.pipe, { cmd: 'prompt', text }, PIPE_REQUEST_TIMEOUT_MS);
}

async function wake(manifest) {
  launchRunner(manifest.name, { flags: manifest.flags });
  const result = await handshake(manifest.name);
  if (!result) {
    reportHandshakeFailure(manifest.name);
    process.exit(1);
  }

  return result;
}

async function sendCommand(argv) {
  const [name, ...textParts] = argv;
  const text = textParts.join(' ');
  if (!name || text.length === 0) {
    fail('usage: pi-dock send <name> <text>');
  }

  const manifest = await requireManifest(name);
  let reply;
  let needsWake = false;

  try {
    reply = await sendPrompt(manifest, text);
  } catch (error) {
    if (isTimeout(error)) {
      failNotResponding(name);
    }
    needsWake = true;
  }

  if (reply && !reply.ok && reply.error === 'terminal') {
    needsWake = true;
  }

  if (needsWake) {
    reply = await sendPrompt((await wake(manifest)).manifest, text);
  }

  if (!reply.ok) {
    fail(JSON.stringify(reply));
  }

  console.log(JSON.stringify(reply));
}

async function startCommand(argv) {
  const [name] = argv;
  if (!name) {
    fail('usage: pi-dock start <name>');
  }

  const manifest = await requireManifest(name);
  try {
    const status = await request(manifest.pipe, { cmd: 'status' }, PIPE_REQUEST_TIMEOUT_MS);
    if (status.ok) {
      console.log(`${name} ${status.state}`);
      return;
    }
  } catch (error) {
    if (isTimeout(error)) {
      failNotResponding(name);
    }
  }

  const result = await wake(manifest);
  console.log(`${name} ${result.status.state}`);
}

async function lsCommand() {
  const manifests = await listManifests();
  console.log('name\tstate\tturns\telapsed\tsession');

  for (const manifest of manifests) {
    const status = await tryStatus(manifest, 200);
    const state = status ? status.state : stateFromLog(manifest.name);
    const turns = status?.turns ?? '-';
    const session = manifest.sessionFile ?? '-';
    console.log(`${manifest.name}\t${state}\t${turns}\t${formatElapsed(manifest.startedAt)}\t${session}`);
  }
}

function printLog(name, fromByte = 0) {
  const file = logPath(name);
  if (!existsSync(file)) {
    fail(`no log for agent: ${name}`);
  }

  const body = readFileSync(file, 'utf8');
  const chunk = body.slice(fromByte);
  for (const line of chunk.split('\n')) {
    if (line.length > 0) {
      console.log(formatLogLine(line));
    }
  }

  return Buffer.byteLength(body);
}

async function logsCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { follow: { type: 'boolean', short: 'f' } },
  });

  const name = positionals[0];
  if (!name) {
    fail('usage: pi-dock logs <name> [--follow]');
  }

  await requireManifest(name);

  let offset = printLog(name);
  while (values.follow) {
    await sleep(500);
    if (existsSync(logPath(name)) && statSync(logPath(name)).size > offset) {
      offset = printLog(name, offset);
    }
  }
}

async function stopCommand(argv) {
  const [name] = argv;
  if (!name) {
    fail('usage: pi-dock stop <name>');
  }

  const manifest = await requireManifest(name);
  try {
    const reply = await request(manifest.pipe, { cmd: 'stop' }, PIPE_REQUEST_TIMEOUT_MS);
    if (reply.ok) {
      console.log('stopped');
      return;
    }
    fail(JSON.stringify(reply));
  } catch (error) {
    if (isTimeout(error)) {
      failNotResponding(name);
    }
    console.log(`already ${stateFromLog(name)}`);
  }
}

try {
  if (command === 'spawn') {
    await spawnCommand(args);
  } else if (command === 'send') {
    await sendCommand(args);
  } else if (command === 'start') {
    await startCommand(args);
  } else if (command === 'ls') {
    await lsCommand();
  } else if (command === 'logs') {
    await logsCommand(args);
  } else if (command === 'stop') {
    await stopCommand(args);
  } else {
    fail('usage: pi-dock <spawn|send|start|stop|ls|logs> ...');
  }
} catch (error) {
  fail(error.message);
}
