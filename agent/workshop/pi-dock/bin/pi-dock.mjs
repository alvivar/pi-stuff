#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listManifests, readManifest, rewriteManifest } from '../src/manifest.mjs';
import { logPath, manifestPath, validateAgentName } from '../src/paths.mjs';
import { PIPE_REQUEST_TIMEOUT_MS, request } from '../src/pipe.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, 'src', 'runner.mjs');
const command = process.argv[2];
const args = process.argv.slice(3);
const USAGE = {
  spawn: 'pi-dock spawn --name <name> [--model <provider/id>] [--thinking <level>] [--x key[=value]]...',
  send: 'pi-dock send <name> <text>',
  start: 'pi-dock start <name>',
  stop: 'pi-dock stop <name>',
  ls: 'pi-dock ls',
  logs: 'pi-dock logs <name> [--tail <n>] [--raw] [--follow]',
  show: 'pi-dock show <name>',
  set: 'pi-dock set <name> [--model <provider/id>] [--thinking <level>] [--x key[=value]]...',
  compact: 'pi-dock compact <name> [instructions]',
  models: 'pi-dock models [filter]',
};
const VALID_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function failUsage(reason) {
  fail(reason ? `${reason}\nusage: ${USAGE[command]}` : `usage: ${USAGE[command]}`);
}

function parseCommand(argv, options, maxPositionals) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true });
  } catch (error) {
    failUsage(error.message.split(/\.\s/)[0]);
  }
  if (parsed.positionals.length > maxPositionals) {
    failUsage(`Unexpected argument '${parsed.positionals[maxPositionals]}'`);
  }

  return parsed;
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

function pipeAbsent(error) {
  return error.code === 'ENOENT' || error.code === 'ECONNREFUSED';
}

function validateThinking(level) {
  if (level && !VALID_THINKING_LEVELS.has(level)) {
    fail(`invalid thinking level: ${level}`);
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

function launchRunner(name, options = {}) {
  const argv = [runner, '--name', name];

  if (options.cwd) {
    argv.push('--cwd', options.cwd);
  }
  if (options.model) {
    argv.push('--model', options.model);
  }
  if (options.thinking) {
    argv.push('--thinking', options.thinking);
  }
  if (options.create) {
    argv.push('--create');
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
  return child;
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

async function verifyModelAuth(modelRuntime, model) {
  const available = await modelRuntime.getAvailable();
  const configured = available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
  if (!configured) {
    throw new Error(`no usable credentials for ${model.provider}/${model.id}`);
  }

  if (!(await modelRuntime.getAuth(model))) {
    throw new Error(`no usable credentials for ${model.provider}/${model.id}`);
  }
}

function modelRef({ provider, id }) {
  return `${provider}/${id}`;
}

async function matchingModels(modelRuntime, filter) {
  const query = filter.toLowerCase();
  const slash = query.indexOf('/');
  return (await modelRuntime.getAvailable())
    .filter((model) => (slash === -1
      ? modelRef(model).toLowerCase().includes(query)
      : model.provider.toLowerCase().includes(query.slice(0, slash)) && model.id.toLowerCase().includes(query.slice(slash + 1))))
    .sort((a, b) => (modelRef(a) < modelRef(b) ? -1 : 1));
}

async function preflightSpawn(cwd, modelSpec) {
  const {
    createAgentSession,
    ModelRuntime,
    SessionManager,
  } = await import('@earendil-works/pi-coding-agent');
  const modelRuntime = await ModelRuntime.create();

  if (modelSpec) {
    const slash = modelSpec.indexOf('/');
    const model = slash === -1 ? null : modelRuntime.getModel(modelSpec.slice(0, slash), modelSpec.slice(slash + 1));
    if (!model) {
      const matches = (await matchingModels(modelRuntime, modelSpec)).map(modelRef);
      const hint = matches.length === 0
        ? 'see: pi-dock models'
        : `did you mean: ${matches.slice(0, 5).join(', ')}${matches.length > 5 ? ', …' : ''}; see: pi-dock models ${modelSpec}`;
      throw new Error(`model ${modelSpec} not found (${hint})`);
    }

    await verifyModelAuth(modelRuntime, model);
    return;
  }

  let session;
  try {
    ({ session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      modelRuntime,
    }));

    if (!session.model) {
      throw new Error('no model with usable credentials available');
    }

    await verifyModelAuth(modelRuntime, session.model);
  } finally {
    session?.dispose();
  }
}

function lastCompleteLogEvent(name) {
  const file = logPath(name);

  if (!existsSync(file)) {
    return null;
  }

  const body = readFileSync(file);
  const lastNewline = body.lastIndexOf(0x0A);
  if (lastNewline === -1) {
    return null;
  }

  const lines = body.subarray(0, lastNewline).toString('utf8').split('\n');
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

function formatAge(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60]]) {
    if (seconds >= size) {
      return `${Math.floor(seconds / size)}${unit}`;
    }
  }

  return `${seconds}s`;
}

async function agentState(manifest) {
  const status = await tryStatus(manifest, 200);
  return status ? status.state : stateFromLog(manifest.name);
}

function renderEvent(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }

  const { ts, event, text, ...fields } = parsed;
  const header = [ts, event, ...Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)].join(' ').replace(/\n/g, '\n  ');
  return text === undefined ? header : `${header}\n${text.replace(/^/gm, '  ')}`;
}

async function spawnCommand(argv) {
  const { values } = parseCommand(argv, {
    name: { type: 'string' },
    model: { type: 'string' },
    thinking: { type: 'string' },
    x: { type: 'string', multiple: true },
  }, 0);
  if (values.name === undefined) {
    failUsage();
  }
  const name = validateAgentName(values.name);

  validateThinking(values.thinking);

  if (await manifestExists(name)) {
    fail(`agent already exists: ${name}`);
  }

  const cwd = process.cwd();
  try {
    await preflightSpawn(cwd, values.model);
  } catch (error) {
    fail(`preflight failed: ${error.message}; no agent was created`);
  }

  const child = launchRunner(name, {
    cwd,
    model: values.model,
    thinking: values.thinking,
    flags: values.x,
    create: true,
  });
  const result = await handshake(name);
  if (!result) {
    reportHandshakeFailure(name);
    process.exit(1);
  }
  if (!Number.isInteger(result.status.pid) || result.status.pid !== child.pid) {
    fail(`agent already exists: ${name}`);
  }

  console.log(`${name} ${result.status.state} ${result.status.model}`);
}

async function wake(manifest) {
  launchRunner(manifest.name, { thinking: manifest.thinking, flags: manifest.flags });
  const result = await handshake(manifest.name);
  if (!result) {
    reportHandshakeFailure(manifest.name);
    process.exit(1);
  }

  return result;
}

function failRequest(name, cmd, error) {
  if (isTimeout(error)) {
    failNotResponding(name);
  }
  fail(`agent ${name} stopped or crashed during ${cmd}`);
}

async function deliver(manifest, msg, timeoutMs) {
  let reply;
  try {
    reply = await request(manifest.pipe, msg, timeoutMs);
  } catch (error) {
    if (!pipeAbsent(error)) {
      failRequest(manifest.name, msg.cmd, error);
    }
  }

  if (reply === undefined || reply.error === 'terminal') {
    const { manifest: woken } = await wake(manifest);
    reply = await request(woken.pipe, msg, timeoutMs).catch((error) => failRequest(manifest.name, msg.cmd, error));
  }

  return reply;
}

async function sendCommand(argv) {
  const [name, ...textParts] = argv;
  const text = textParts.join(' ');
  if (name === undefined || text.length === 0) {
    failUsage();
  }

  validateAgentName(name);
  const reply = await deliver(await requireManifest(name), { cmd: 'prompt', text }, PIPE_REQUEST_TIMEOUT_MS);
  if (!reply.ok) {
    fail(JSON.stringify(reply));
  }

  console.log(JSON.stringify(reply));
}

async function startCommand(argv) {
  const { positionals: [name] } = parseCommand(argv, {}, 1);
  if (name === undefined) {
    failUsage();
  }

  validateAgentName(name);
  const manifest = await requireManifest(name);
  try {
    const status = await request(manifest.pipe, { cmd: 'status' }, PIPE_REQUEST_TIMEOUT_MS);
    if (status.ok) {
      console.log(`${name} ${status.state} ${status.model}`);
      return;
    }
  } catch (error) {
    if (isTimeout(error)) {
      failNotResponding(name);
    }
  }

  const result = await wake(manifest);
  console.log(`${name} ${result.status.state} ${result.status.model}`);
}

// Same token formatting as `pi --list-models`.
function formatTokenCount(count) {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return count.toString();
}

async function modelsCommand(argv) {
  const { positionals: [filter = ''] } = parseCommand(argv, {}, 1);
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const models = await matchingModels(await ModelRuntime.create(), filter);
  if (models.length === 0) {
    fail(filter ? `no available models match ${filter}` : 'no available models');
  }

  const rows = [
    ['model', 'context', 'max-out', 'thinking', 'images'],
    ...models.map((model) => [
      modelRef(model),
      formatTokenCount(model.contextWindow),
      formatTokenCount(model.maxTokens),
      model.reasoning ? 'yes' : 'no',
      model.input.includes('image') ? 'yes' : 'no',
    ]),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd());
  }
}

async function lsCommand(argv) {
  parseCommand(argv, {}, 0);
  const manifests = await listManifests();
  console.log('name\tstate\tmodel\tage');

  for (const manifest of manifests) {
    console.log(`${manifest.name}\t${await agentState(manifest)}\t${manifest.model}\t${formatAge(manifest.startedAt)}`);
  }
}

async function showCommand(argv) {
  const { positionals: [name] } = parseCommand(argv, {}, 1);
  if (name === undefined) {
    failUsage();
  }

  validateAgentName(name);
  const manifest = await requireManifest(name);
  console.log([
    `name ${manifest.name}`,
    `state ${await agentState(manifest)}`,
    `model ${manifest.model}`,
    `thinking ${manifest.thinking ?? '-'}`,
    `flags ${JSON.stringify(manifest.flags)}`,
    `cwd ${manifest.cwd}`,
    `session ${manifest.sessionFile}`,
    `created ${manifest.startedAt}`,
  ].join('\n'));
}

function readCompleteLines(name, offset) {
  const body = readFileSync(logPath(name));
  const end = Math.max(offset, body.lastIndexOf(0x0A) + 1);
  return { lines: body.subarray(offset, end).toString('utf8').split('\n').slice(0, -1), end };
}

async function logsCommand(argv) {
  const { values, positionals: [name] } = parseCommand(argv, {
    tail: { type: 'string' },
    raw: { type: 'boolean' },
    follow: { type: 'boolean', short: 'f' },
  }, 1);
  if (name === undefined) {
    failUsage();
  }
  if (values.tail !== undefined && !/^[1-9]\d*$/.test(values.tail)) {
    failUsage(`Option '--tail' must be a positive integer, got '${values.tail}'`);
  }

  validateAgentName(name);
  await requireManifest(name);
  if (!existsSync(logPath(name))) {
    fail(`no log for agent: ${name}`);
  }

  const print = (lines) => {
    for (const line of lines) {
      console.log(values.raw ? line : renderEvent(line));
    }
  };
  let { lines, end } = readCompleteLines(name, 0);
  print(values.tail === undefined ? lines : lines.slice(-Number(values.tail)));
  while (values.follow) {
    await sleep(500);
    ({ lines, end } = readCompleteLines(name, end));
    print(lines);
  }
}

async function confirmPipeAbsent(manifest, name) {
  try {
    const status = await request(manifest.pipe, { cmd: 'status' });
    if (status?.ok === true && typeof status.state === 'string') {
      fail(`agent ${name} is running — stop it first`);
    }
    fail(`agent ${name} liveness check failed: invalid status reply`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`agent ${name} liveness check failed: invalid status reply`);
    }
    if (error.code === 'ETIMEDOUT') {
      failNotResponding(name);
    }
    if (pipeAbsent(error)) {
      return;
    }
    fail(`agent ${name} liveness check failed: ${error.message}`);
  }
}

async function setCommand(argv) {
  const { values, positionals: [name] } = parseCommand(argv, {
    model: { type: 'string' },
    thinking: { type: 'string' },
    x: { type: 'string', multiple: true },
  }, 1);
  if (name === undefined || (!values.model && !values.thinking && values.x === undefined)) {
    failUsage();
  }

  validateAgentName(name);
  validateThinking(values.thinking);
  const manifest = await requireManifest(name);
  await confirmPipeAbsent(manifest, name);

  if (values.model) {
    try {
      await preflightSpawn(manifest.cwd, values.model);
    } catch (error) {
      fail(`preflight failed: ${error.message}; no agent was changed`);
    }
  }

  const updated = {
    name: manifest.name,
    sessionFile: manifest.sessionFile,
    cwd: manifest.cwd,
    model: values.model || manifest.model,
    thinking: values.thinking || manifest.thinking,
    flags: values.x ?? manifest.flags,
    pipe: manifest.pipe,
    startedAt: manifest.startedAt,
  };

  await rewriteManifest(name, updated);
  console.log(`${name} model=${updated.model ?? '-'} thinking=${updated.thinking ?? '-'} flags=${JSON.stringify(updated.flags ?? [])}`);
}

async function compactCommand(argv) {
  const [name, ...instructionParts] = argv;
  if (name === undefined) {
    failUsage();
  }

  const instructions = instructionParts.join(' ');
  validateAgentName(name);
  const msg = instructions.length > 0 ? { cmd: 'compact', instructions } : { cmd: 'compact' };
  const reply = await deliver(await requireManifest(name), msg, null);
  if (!reply.ok) {
    if (reply.error === 'busy') {
      fail(`agent ${name} is busy`);
    }
    fail(reply.error ?? JSON.stringify(reply));
  }

  console.log('compacted');
}

async function stopCommand(argv) {
  const { positionals: [name] } = parseCommand(argv, {}, 1);
  if (name === undefined) {
    failUsage();
  }

  validateAgentName(name);
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

const HELP = `pi-dock — resident AI agents with durable Pi sessions

Usage:
${Object.values(USAGE).map((line) => `  ${line}`).join('\n')}

Agents are resident. spawn creates an idle identity in the current cwd and never takes work; spawn and start print <name> <state> <provider/id>. models lists the provider/id refs usable with --model (models with configured credentials; filter is a case-insensitive substring of provider/id, or provider-part/id-part when it contains a slash); --thinking is off|minimal|low|medium|high|xhigh|max. send never creates an agent: it only delivers text and acknowledges; replies are {event:"text"} records in logs <name>. logs prints each event as a <ts> <event> [key=value]... line; a text event's text follows verbatim on its own lines, each indented two spaces. logs --raw prints the stored NDJSON lines instead, --tail <n> only the last n events, and --follow keeps printing new events until interrupted. show prints name, state, model, thinking (- when unset), flags (JSON array), cwd, session, and created, one key value per line, without waking the agent.

stop is a zero-process power-off: identity, log, and session memory remain; there is no destructive command. start, send, or compact wakes a stopped/failed agent; if the agent stops or crashes mid-request, send and compact report it instead of waking or retrying. ls derives idle/running/compacting while its pipe responds, otherwise stopped after a stop log or failed after a crash/other final log; its columns are name, state, model, and age (time since creation in its largest whole unit: s, m, h, or d). Unknown options and extra arguments are rejected with the command's usage; send and compact take all remaining arguments as text. If an agent is not responding, find the latest {event:"spawned",pid} in logs <name>, terminate that PID externally, then run pi-dock start <name>; do not retry-loop.

compact is idle-only and waits without a timeout until the runner replies (Ctrl-C only stops waiting); the agent stays on, and a failed compaction is logged as {event:"compact_failed",reason}. set requires a stopped/failed agent; it changes model, thinking, and/or replaces the entire repeatable --x flag list, then next wake applies it. --x flags are opaque and inert without their extension.`;

try {
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(HELP);
  } else if (command === 'spawn') {
    await spawnCommand(args);
  } else if (command === 'send') {
    await sendCommand(args);
  } else if (command === 'start') {
    await startCommand(args);
  } else if (command === 'ls') {
    await lsCommand(args);
  } else if (command === 'show') {
    await showCommand(args);
  } else if (command === 'logs') {
    await logsCommand(args);
  } else if (command === 'set') {
    await setCommand(args);
  } else if (command === 'models') {
    await modelsCommand(args);
  } else if (command === 'compact') {
    await compactCommand(args);
  } else if (command === 'stop') {
    await stopCommand(args);
  } else {
    fail(`unknown command: ${command}; run pi-dock --help`);
  }
} catch (error) {
  fail(error.message);
}
