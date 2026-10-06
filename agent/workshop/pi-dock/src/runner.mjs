import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
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
  appendLog({ event: 'run', id });

  try {
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
  queued.add(id);
  appendLog({ event: 'queued', id });
  queue = queue.then(() => runOnePrompt(id, text));
  void queue.catch(() => {});
  return id;
}

function busyForCompact() {
  return current || compacting || queued.size > 0 || session?.isStreaming;
}

async function runOneCompact(instructions) {
  try {
    await session.compact(instructions);
    if (!terminal) {
      appendLog({ event: 'compacted' });
    }
    return { ok: true };
  } catch (error) {
    if (!terminal) {
      appendLog({ event: 'compact_failed', reason: error.message });
    }
    return { ok: false, error: error.message };
  } finally {
    compacting = false;
  }
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
  queue = task.then(() => undefined, () => undefined);
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
  if (!createMode && !existing.model) {
    throw new Error(`manifest model missing: ${name} — set --model <provider/id> to repair`);
  }
  const cwd = createMode ? path.resolve(values.cwd ?? process.cwd()) : existing.cwd;
  const flags = createMode ? values.x ?? [] : existing.flags ?? [];
  const thinking = createMode ? values.thinking : existing.thinking;

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
  });

  server = serve(pipe, (msg) => {
    if (msg.cmd === 'status') {
      if (terminal || !session) {
        return { ok: false, error: 'terminal' };
      }

      const state = compacting ? 'compacting' : current || session.isStreaming ? 'running' : 'idle';
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

  server.once('listening', () => {
    appendLog({ event: 'spawned', pid: process.pid });
  });
  server.on('error', (error) => {
    if (error.piDockRetrying) {
      return;
    }

    void fail(error);
  });
} catch (error) {
  await fail(error);
}
