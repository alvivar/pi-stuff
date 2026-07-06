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
import { dockDir, ensureDockDir, pipePath } from './paths.mjs';
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

const logPath = path.join(dockDir(), `${name}.log`);
const pipe = pipePath(name);
let session;
let server;
let unsubscribe = () => {};
let turns = 0;
let pending = 0;
let terminal = false;
let budgetTimer;
let budgetConfig;

function appendLog(event) {
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8');
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

function finish(event, code) {
  if (terminal) {
    return;
  }

  terminal = true;
  clearTimeout(budgetTimer);
  unsubscribe();
  session?.dispose();
  appendLog(event);
  closeServerThenExit(code);
}

async function fail(error) {
  if (terminal) {
    return;
  }

  terminal = true;
  clearTimeout(budgetTimer);
  unsubscribe();
  await session?.abort().catch(() => {});
  session?.dispose();
  appendLog({ event: 'failed', reason: error.message });
  closeServerThenExit(1);
}

async function stopSoon() {
  if (terminal) {
    return;
  }

  terminal = true;
  clearTimeout(budgetTimer);
  unsubscribe();
  await session?.abort().catch(() => {});
  session?.dispose();
  appendLog({ event: 'stopped' });
  closeServerThenExit(0);
}

function startBudgetTimer(budget) {
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

function runPrompt(text) {
  if (terminal || !session) {
    return false;
  }

  pending += 1;
  if (!budgetTimer) {
    startBudgetTimer(budgetConfig);
  }
  void session.prompt(text, { streamingBehavior: 'followUp' })
    .then(() => {
      pending -= 1;
      if (pending === 0 && !terminal) {
        finish({ event: 'done' }, 0);
      }
    })
    .catch((error) => {
      pending -= 1;
      void fail(error);
    });

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

      const state = session.isStreaming || pending > 0 ? 'running' : 'idle';
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
