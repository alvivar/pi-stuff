import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { ManifestExistsError, readManifest, writeManifest } from './manifest.mjs';
import { ensureDockDir, logPath, pipePath } from './paths.mjs';
import { serve } from './pipe.mjs';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    cwd: { type: 'string' },
    model: { type: 'string' },
    thinking: { type: 'string' },
    x: { type: 'string', multiple: true },
    create: { type: 'boolean' },
  },
});

const name = values.name;

if (!name) {
  process.exit(1);
}

const log = logPath(name);
const pipe = pipePath(name);
let session;
let server;
let unsubscribe = () => {};
let current;
let runError;
let compacting = false;
const queued = new Set();
let terminal = false;
let queue = Promise.resolve();
// Settles once the runner is ready or terminal; pipe requests that arrive earlier wait for it.
let settleStartup;
const startup = new Promise((resolve) => {
  settleStartup = resolve;
});

const theme = {
  fg: (_role, text) => text,
  bg: (_role, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  inverse: (text) => text,
  strikethrough: (text) => text,
  style: (text) => text,
  getFgAnsi: () => '',
  getBgAnsi: () => '',
  getColorMode: () => '256color',
  getThinkingBorderColor: () => (text) => text,
  getBashModeBorderColor: () => (text) => text,
};
const headlessUIContext = {
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  notify: () => {},
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  setWorkingIndicator: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  custom: async () => undefined,
  pasteToEditor: () => {},
  setEditorText: () => {},
  getEditorText: () => '',
  editor: async () => undefined,
  addAutocompleteProvider: () => {},
  setEditorComponent: () => {},
  getEditorComponent: () => undefined,
  theme,
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: 'UI not available' }),
  getToolsExpanded: () => false,
  setToolsExpanded: () => {},
};

function appendLog(event) {
  appendFileSync(log, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8');
}

// A final line cut short (power loss, full disk) would merge with this boot's first event into a
// complete but invalid line, so the owner drops it. A missing log stays missing.
function dropTornTail() {
  let body;
  try {
    body = readFileSync(log);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const end = body.lastIndexOf('\n') + 1;
  if (end < body.length) {
    truncateSync(log, end);
  }
}

function parseExtensionFlags(flags) {
  return new Map(flags.map((flag) => {
    const equals = flag.indexOf('=');
    return equals === -1 ? [flag, true] : [flag.slice(0, equals), flag.slice(equals + 1)];
  }));
}

function thinkingOption(level) {
  return level ? { thinkingLevel: level } : {};
}

function textFromMessage(message) {
  if (!Array.isArray(message?.content)) {
    return '';
  }

  return message.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}

function closeServerThenExit(code) {
  if (!server?.listening) {
    process.exit(code);
  }

  server.close(() => process.exit(code));
}

async function shutdown(event, details, code) {
  if (terminal) {
    return;
  }

  terminal = true;
  settleStartup();
  const dropped = [...queued];
  const interrupted = current;
  unsubscribe();
  await session?.abort().catch(() => {});
  session?.dispose();
  if (dropped.length > 0) {
    appendLog({ event: 'dropped', ids: dropped });
  }
  appendLog({ event, ...(interrupted && { id: interrupted }), ...details });
  closeServerThenExit(code);
}

function fail(error) {
  return shutdown('failed', { reason: error.message }, 1);
}

function stopSoon() {
  return shutdown('stopped', {}, 0);
}

function subscribeToSession() {
  unsubscribe = session.subscribe((event) => {
    if (terminal) {
      return;
    }

    if (event.type === 'turn_start') {
      appendLog({ event: 'turn', ...(current && { id: current }) });
      return;
    }

    // A custom message entered the context: through the agent loop (message_start), or as an
    // entry an extension appended at a turn boundary (entry_appended). Type only, never content.
    if (event.type === 'message_start' && event.message.role === 'custom') {
      appendLog({ event: 'external', ...(current && { id: current }), type: event.message.customType });
      return;
    }
    if (event.type === 'entry_appended' && event.entry.type === 'custom_message') {
      appendLog({ event: 'external', ...(current && { id: current }), type: event.entry.customType });
      return;
    }

    if (event.type === 'turn_end') {
      if (current) {
        const { stopReason, errorMessage } = event.message;
        runError = stopReason === 'error' || stopReason === 'aborted' ? errorMessage || stopReason : undefined;
      }
      const text = textFromMessage(event.message);
      if (text) {
        appendLog({ event: 'text', ...(current && { id: current }), text });
      }
    }
  });
}

async function runOnePrompt(id, text) {
  // Idle extension work finishes first and keeps no id; until then the prompt stays queued.
  await session.waitForIdle();
  if (terminal) {
    return;
  }

  queued.delete(id);
  current = id;
  runError = undefined;
  try {
    appendLog({ event: 'run', id });
    await session.prompt(text, { streamingBehavior: 'followUp' });
    // A prompt that joined an already streaming run returns at once; its outcome is that run's.
    await session.waitForIdle();
    if (!terminal) {
      appendLog(runError === undefined ? { event: 'done', id } : { event: 'run_failed', id, reason: runError });
    }
  } catch (error) {
    await fail(error);
  } finally {
    current = undefined;
  }
}

function runPrompt(text) {
  if (terminal || !session) {
    return undefined;
  }

  const id = `p${randomBytes(6).toString('hex')}`;
  // Log first: a failed write rejects the request and leaves no phantom queued prompt.
  appendLog({ event: 'queued', id });
  queued.add(id);
  // Nothing handles the queue: a task can reject only if fail() itself fails, and that crashes
  // the runner instead of stalling the prompts behind it.
  queue = queue.then(() => runOnePrompt(id, text));
  return id;
}

function busyForCompact() {
  return current || compacting || queued.size > 0 || session?.isStreaming || session?.isCompacting;
}

async function runOneCompact(instructions) {
  let reply;
  try {
    await session.compact(instructions);
    reply = { ok: true };
  } catch (error) {
    reply = { ok: false, error: error.message };
  } finally {
    compacting = false;
  }

  // A compaction error is its outcome; a log failure is the runner's, like in runOnePrompt.
  try {
    if (!terminal) {
      appendLog(reply.ok ? { event: 'compacted' } : { event: 'compact_failed', reason: reply.error });
    }
  } catch (error) {
    await fail(error);
  }
  return reply;
}

function runCompact(instructions) {
  if (terminal || !session) {
    return { ok: false, error: 'terminal' };
  }
  if (busyForCompact()) {
    return { ok: false, error: 'busy' };
  }

  compacting = true;
  const compactInstructions = typeof instructions === 'string' && instructions.length > 0 ? instructions : undefined;
  const task = queue.then(() => runOneCompact(compactInstructions));
  // The pipe handles task; this unhandled tail crashes the runner if task rejects, as for prompts.
  queue = task.then(() => undefined);
  return task;
}

function findModel(modelRuntime, spec) {
  const slash = spec.indexOf('/');
  if (slash === -1) {
    throw new Error(`model not found: ${spec}`);
  }

  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  const model = modelRuntime.getModel(provider, id);
  if (!model) {
    throw new Error(`model not found: ${spec}`);
  }

  return model;
}

try {
  await ensureDockDir();

  // Only --create creates: a wake whose manifest is gone fails instead of starting a new agent.
  const createMode = values.create;
  const existing = createMode ? null : await readManifest(name);
  const cwd = createMode ? path.resolve(values.cwd ?? process.cwd()) : existing.cwd;
  const flags = createMode ? values.x ?? [] : existing.flags;
  const thinking = createMode ? values.thinking : existing.thinking;

  // Own the pipe before opening the session or loading extensions, so that of concurrent runners
  // for one agent only the owner does either.
  server = serve(pipe, async (msg) => {
    await startup;
    if (msg.cmd === 'status') {
      if (terminal || !session) {
        return { ok: false, error: 'terminal' };
      }

      // compacting reserves the runner until its own compact settles (the SDK clears isCompacting
      // earlier); isCompacting adds compactions others started, such as an extension's.
      const state = compacting || session.isCompacting
        ? 'compacting'
        : current || session.isStreaming ? 'running' : 'idle';
      return { ok: true, state, model: `${session.model.provider}/${session.model.id}`, pid: process.pid };
    }

    if (msg.cmd === 'prompt') {
      const id = runPrompt(msg.text);
      return id ? { ok: true, id } : { ok: false, error: 'terminal' };
    }

    if (msg.cmd === 'compact') {
      return runCompact(msg.instructions);
    }

    if (msg.cmd === 'stop') {
      setImmediate(() => {
        void stopSoon();
      });
      return { ok: true, pid: process.pid };
    }

    return { ok: false, error: 'unknown' };
  });
  server.on('error', (error) => {
    if (error.piDockRetrying) {
      return;
    }
    if (error.code === 'EADDRINUSE') {
      // Another runner owns this agent: leave its log, manifest and session untouched.
      process.exit(0);
    }

    void fail(error);
  });
  await new Promise((resolve) => {
    server.once('listening', resolve);
  });
  dropTornTail();
  // Logged as soon as this runner owns the agent, so its PID is known even if startup hangs.
  appendLog({ event: 'spawned', pid: process.pid });

  const services = await createAgentSessionServices({
    cwd,
    extensionFlagValues: parseExtensionFlags(flags),
  });
  const modelSpec = createMode ? values.model : existing.model;
  const model = modelSpec ? findModel(services.modelRuntime, modelSpec) : undefined;
  const sessionManager = createMode ? SessionManager.create(cwd) : SessionManager.open(existing.sessionFile);
  ({ session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(model ? { model } : {}),
    ...thinkingOption(thinking),
  }));

  if (createMode) {
    const resolvedModel = model ?? session.model;
    if (!resolvedModel?.provider || !resolvedModel?.id) {
      session.dispose();
      session = undefined;
      throw new Error('no model with usable credentials available');
    }
    const manifest = {
      name,
      sessionFile: session.sessionFile,
      cwd,
      model: `${resolvedModel.provider}/${resolvedModel.id}`,
      flags,
      pipe,
      startedAt: new Date().toISOString(),
    };
    if (thinking) {
      manifest.thinking = thinking;
    }
    try {
      await writeManifest(name, manifest);
    } catch (error) {
      if (error instanceof ManifestExistsError) {
        session.dispose();
        process.exit(0);
      }
      throw error;
    }
  }

  subscribeToSession();
  await session.bindExtensions({
    uiContext: headlessUIContext,
    mode: 'print',
    shutdownHandler: () => {
      void stopSoon();
    },
    // The SDK catches a handler's throw and the agent carries on; only the log records it.
    onError: ({ extensionPath, event, error }) => {
      // Like session events: once shutdown begins, nothing may follow the terminal event.
      if (terminal) {
        return;
      }
      appendLog({
        event: 'extension_error',
        ...(current && { id: current }),
        extension: extensionPath,
        on: event,
        reason: error,
      });
    },
  });

  settleStartup();
} catch (error) {
  await fail(error);
}
