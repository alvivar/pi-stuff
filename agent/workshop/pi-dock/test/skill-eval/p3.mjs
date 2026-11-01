// P3 — a batch stop that failed. A, B and C are on. The previous operator ran `stop A B <typo>`,
// which checked the whole list first and stopped nothing. The solver must stop A and B (not
// assume the failed command stopped them), try to compact A first and report the real outcome
// (its session is too small: compaction fails, the agent stays on), leave C untouched, and keep
// every log and session.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { evalRules, WORKER_MODEL, logEvents, mustPiDock, piDock, processAlive, readManifest, sendAndSettle, textReply } from './lib.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function prefixOf(file) {
  const bytes = await fs.readFile(file);
  return { file, bytes: bytes.length, hash: hash(bytes) };
}

// The file still starts with the bytes it had after setup (later events or entries may follow).
async function prefixKept(prefix) {
  let bytes;
  try {
    bytes = await fs.readFile(prefix.file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  return bytes.length >= prefix.bytes && hash(bytes.subarray(0, prefix.bytes)) === prefix.hash;
}

async function snapshot(attempt, name) {
  const manifest = await readManifest(attempt, name);
  const events = await logEvents(attempt, name);
  return {
    manifest,
    session: await prefixOf(manifest.sessionFile),
    log: await prefixOf(path.join(attempt.dock, `${name}.log`)),
    setupEvents: events.length,
    pid: events.findLast((event) => event.event === 'spawned').pid,
  };
}

export async function setup({ attempt, provider }) {
  const [a, b, c] = ['alpha', 'beta', 'gamma'].map((role) => `${attempt.prefix}${role}`);
  const typo = `${attempt.prefix}betta`;
  const project = path.join(attempt.work, 'project');
  await fs.mkdir(project);
  provider.script.push(textReply('Hello from alpha.'), textReply('Hello from beta.'), textReply('Hello from gamma.'));
  for (const name of [a, b, c]) {
    mustPiDock(attempt, ['spawn', '--name', name, '--model', WORKER_MODEL], project);
    await sendAndSettle(attempt, name, 'Say hello.');
  }
  const failedStop = piDock(attempt, ['stop', a, b, typo]);
  if (failedStop.code !== 1) {
    throw new Error(`fixture: the typo stop should fail: ${JSON.stringify(failedStop)}`);
  }
  const states = mustPiDock(attempt, ['ls']).stdout;
  for (const name of [a, b, c]) {
    if (!new RegExp(`^${name}\\s+idle\\s`, 'm').test(states)) {
      throw new Error(`fixture: ${name} should still be idle after the failed stop:\n${states}`);
    }
  }
  provider.fallback = textReply('Done.');
  return {
    a,
    b,
    c,
    typo,
    failedStop,
    before: { [a]: await snapshot(attempt, a), [b]: await snapshot(attempt, b), [c]: await snapshot(attempt, c) },
  };
}

export function prompt({ attempt }, state) {
  return `You are taking over from another operator. pi-dock is installed for you as this command; use it wherever pi-dock's documentation says \`pi-dock\`:

  node "${attempt.wrapper}"

Three background agents work for a project: \`${state.a}\`, \`${state.b}\` and \`${state.c}\`. The previous operator wanted to power off \`${state.a}\` and \`${state.b}\` and ran:

  pi-dock stop ${state.a} ${state.b} ${state.typo}

It printed this on stderr and exited ${state.failedStop.code}:

${state.failedStop.stderr.trim().split('\n').map((line) => `  ${line}`).join('\n')}

Your job:
1. Before \`${state.a}\` is powered off, compact its session if that is possible, and report what really happened.
2. Make sure \`${state.a}\` and \`${state.b}\` end up powered off.
3. \`${state.c}\` must keep running exactly as it is: do not stop, restart or change it.
4. Keep every agent's log and session.
5. Write what you did and the real state of each of the three agents to ${path.join(attempt.work, 'answer.md')}.

${evalRules(attempt, { operating: true })}
`;
}

// The booleans are measurements; success is decided by reading answer.md and the trace.
export async function measure({ attempt, provider }, state) {
  const status = async (name) => {
    const before = state.before[name];
    const events = await logEvents(attempt, name);
    const manifest = await readManifest(attempt, name);
    return {
      before,
      after: events.slice(before.setupEvents),
      lastEvent: events.at(-1).event,
      pid: events.findLast((event) => event.event === 'spawned').pid,
      manifestUnchanged: JSON.stringify(manifest) === JSON.stringify(before.manifest),
      kept: manifest !== undefined && manifest.sessionFile === before.manifest.sessionFile && await prefixKept(before.session) && await prefixKept(before.log),
    };
  };
  const [a, b, c] = [await status(state.a), await status(state.b), await status(state.c)];
  let answer = null;
  try {
    answer = await fs.readFile(path.join(attempt.work, 'answer.md'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  const dockNames = (await fs.readdir(attempt.dock)).filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -5)).sort();
  const compactIndex = a.after.findIndex((event) => event.event.startsWith('compact'));
  const stopIndex = a.after.findIndex((event) => event.event === 'stopped');
  return {
    abStopped: { pass: [a, b].every((agent) => agent.lastEvent === 'stopped' && !processAlive(agent.pid)) },
    // For C the session must be unchanged, not just kept: same length as after setup.
    cUntouched: { pass: c.after.length === 0 && c.pid === c.before.pid && processAlive(c.pid) && c.manifestUnchanged && c.kept && (await fs.stat(c.before.session.file)).size === c.before.session.bytes, cEventsAfterSetup: c.after.map((event) => event.event) },
    compactTriedFirst: { pass: compactIndex !== -1 && (stopIndex === -1 || compactIndex < stopIndex), aEventsAfterSetup: a.after.map((event) => event.event + (event.reason ? `: ${event.reason}` : '')) },
    logsAndSessionsKept: { pass: [a, b, c].every((agent) => agent.kept) },
    noOtherAgents: { pass: JSON.stringify(dockNames) === JSON.stringify([state.a, state.b, state.c].sort()), dockNames },
    workerRequestsDuringSolver: provider.requests.filter((entry) => entry.phase === 'solver').length,
    answer,
  };
}
