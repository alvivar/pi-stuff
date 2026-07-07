import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { readManifest, writeManifest } from './manifest.mjs';
import { ensureDockDir, logPath, pipePath } from './paths.mjs';
import { serve } from './pipe.mjs';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    cwd: { type: 'string' },
    model: { type: 'string' },
    budget: { type: 'string' },
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
let turns = 0;
let running = false;
let pending = 0;
let terminal = false;
let budgetTimer;
let budgetConfig;
let queue = Promise.resolve();

function appendLog(event) {
  appendFileSync(log, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8');
}

function parseBudget(value) {
  const [turnText = '20', minuteText = '30'] = (value ?? '20,30').split(',');
  const turnLimit = Number.parseInt(turnText, 10);
  const minuteLimit = Number.parseFloat(minuteText);

  if (!Number.isFinite(turnLimit) || turnLimit < 1 || !Number.isFinite(minuteLimit) || minuteLimit <= 0) {
    throw new Error('invalid budget');
  }

  return { turns: turnLimit, minutes: minuteLimit };
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

async function shutdown(event, code) {
  if (terminal) {
    return;
  }

  terminal = true;
  const dropped = pending;
  clearBudgetTimer();
  unsubscribe();
  await session?.abort().catch(() => {});
  session?.dispose();
  if (dropped > 0) {
    appendLog({ event: 'dropped', n: dropped });
  }
  appendLog(event);
  closeServerThenExit(code);
}

function fail(error) {
  return shutdown({ event: 'failed', reason: error.message }, 1);
}

function stopSoon() {
  return shutdown({ event: 'stopped' }, 0);
}

function clearBudgetTimer() {
  clearTimeout(budgetTimer);
  budgetTimer = undefined;
}

function startBudgetTimer(budget) {
  clearBudgetTimer();
  budgetTimer = setTimeout(() => {
    void fail(new Error('budget'));
  }, budget.minutes * 60 * 1000);
  budgetTimer.unref();
}

function subscribeToSession(budget) {
  unsubscribe = session.subscribe((event) => {
    if (terminal) {
      return;
    }

    if (event.type === 'turn_start') {
      turns += 1;
      appendLog({ event: 'turn', n: turns });
      if (turns > budget.turns) {
        void fail(new Error('budget'));
      }
      return;
    }

    if (event.type === 'turn_end') {
      const text = textFromMessage(event.message);
      if (text) {
        appendLog({ event: 'text', text });
      }
    }
  });
}

async function runOnePrompt(text) {
  if (terminal || !session) {
    pending -= 1;
    return;
  }

  pending -= 1;
  running = true;
  turns = 0;
  startBudgetTimer(budgetConfig);

  try {
    await session.prompt(text, { streamingBehavior: 'followUp' });
    if (!terminal) {
      appendLog({ event: 'idle' });
    }
  } catch (error) {
    await fail(error);
  } finally {
    clearBudgetTimer();
    turns = 0;
    running = false;
  }
}

function runPrompt(text) {
  if (terminal || !session) {
    return false;
  }

  pending += 1;
  queue = queue.then(() => runOnePrompt(text));
  void queue.catch(() => {});
  return true;
}

async function findModel(modelRegistry, spec) {
  if (!spec) {
    return undefined;
  }

  const slash = spec.indexOf('/');
  if (slash === -1) {
    throw new Error(`model not found: ${spec}`);
  }

  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  const model = modelRegistry.find(provider, id);
  if (!model) {
    throw new Error(`model not found: ${spec}`);
  }

  return model;
}

try {
  await ensureDockDir();

  const existing = await readManifest(name).catch((error) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  const createMode = existing === null;
  const cwd = createMode ? path.resolve(values.cwd ?? process.cwd()) : existing.cwd;
  const budget = createMode ? parseBudget(values.budget) : existing.budget;
  budgetConfig = budget;

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = createMode ? await findModel(modelRegistry, values.model) : undefined;
  const sessionManager = createMode ? SessionManager.create(cwd) : SessionManager.open(existing.sessionFile);
  ({ session } = await createAgentSession({
    cwd,
    sessionManager,
    authStorage,
    modelRegistry,
    ...(model ? { model } : {}),
  }));

  if (createMode) {
    await writeManifest(name, {
      name,
      sessionFile: session.sessionFile,
      cwd,
      modelId: session.model?.id ?? null,
      budget,
      pipe,
      startedAt: new Date().toISOString(),
    });
  }

  appendLog({ event: 'spawned' });
  subscribeToSession(budget);

  server = serve(pipe, (msg) => {
    if (msg.cmd === 'status') {
      if (terminal || !session) {
        return { ok: false, error: 'terminal' };
      }

      const state = running || session.isStreaming ? 'running' : 'idle';
      return { ok: true, state, turns };
    }

    if (msg.cmd === 'prompt') {
      if (!runPrompt(msg.text)) {
        return { ok: false, error: 'terminal' };
      }

      return { ok: true };
    }

    if (msg.cmd === 'stop') {
      setImmediate(() => {
        void stopSoon();
      });
      return { ok: true };
    }

    return { ok: false, error: 'unknown' };
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
