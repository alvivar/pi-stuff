#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listManifests, readManifest } from '../src/manifest.mjs';
import { dockDir, pipePath } from '../src/paths.mjs';
import { request } from '../src/pipe.mjs';

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

function manifestPath(name) {
  return path.join(dockDir(), `${name}.json`);
}

function logPath(name) {
  return path.join(dockDir(), `${name}.log`);
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
      fail(`unknown agent: ${name}`);
    }
    throw error;
  }
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
  if (event?.event === 'stopped' || event?.event === 'done' || event?.event === 'failed') {
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
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { name: { type: 'string' } },
  });

  const name = values.name;
  if (!name) {
    fail('usage: pi-dock spawn --name <name> [text]');
  }

  if (await manifestExists(name)) {
    fail(`agent already exists: ${name}`);
  }

  const child = spawn(process.execPath, [runner, '--name', name], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const manifest = await readManifest(name).catch(() => null);
    if (manifest) {
      const status = await tryStatus(manifest, 200);
      if (status) {
        console.log(`${name} ${status.state}`);
        return;
      }
    }
    await sleep(100);
  }

  console.error(`spawn handshake failed for ${name}`);
  console.error(`manifest: ${manifestPath(name)} ${existsSync(manifestPath(name)) ? 'exists' : 'missing'}`);
  console.error(`log: ${logPath(name)} ${existsSync(logPath(name)) ? 'exists' : 'missing'}`);
  process.exit(1);
}

async function sendCommand(argv) {
  const [name, ...textParts] = argv;
  const text = textParts.join(' ');
  if (!name || text.length === 0) {
    fail('usage: pi-dock send <name> <text>');
  }

  const manifest = await requireManifest(name);
  try {
    const reply = await request(manifest.pipe, { cmd: 'prompt', text }, 1000);
    console.log(JSON.stringify(reply));
  } catch {
    fail(`agent not running: ${name}`);
  }
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
    fail(`unknown log: ${name}`);
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
    const reply = await request(manifest.pipe, { cmd: 'stop' }, 1000);
    if (reply.ok) {
      console.log('stopped');
      return;
    }
    fail(JSON.stringify(reply));
  } catch {
    console.log(`already ${stateFromLog(name)}`);
  }
}

try {
  if (command === 'spawn') {
    await spawnCommand(args);
  } else if (command === 'send') {
    await sendCommand(args);
  } else if (command === 'ls') {
    await lsCommand();
  } else if (command === 'logs') {
    await logsCommand(args);
  } else if (command === 'stop') {
    await stopCommand(args);
  } else {
    fail('usage: pi-dock <spawn|send|ls|logs|stop> ...');
  }
} catch (error) {
  fail(error.message);
}
