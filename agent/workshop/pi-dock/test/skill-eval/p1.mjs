// P1 — resume a delivery without repeating the work. A non-idempotent task already ran to
// completion: it wrote report.md in an earlier turn and its last turn had no text. The solver has
// only the prompt id; it must re-attach, not re-send, read an empty final answer as success, and
// leave the agent off with its memory.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { evalRules, WORKER_MODEL, emptyReply, logEvents, mustPiDock, processAlive, readManifest, sha256, textReply, toolReply, waitForLog } from './lib.mjs';

const REPORT = '# Q3 summary\n\nRevenue grew 12% over Q2; churn fell to 3.1%.\n';

export async function setup({ attempt, provider }) {
  const name = `${attempt.prefix}writer`;
  const project = path.join(attempt.work, 'project');
  await fs.mkdir(project);
  const taskFile = path.join(attempt.dir, 'fixture-task.md');
  await fs.writeFile(taskFile, 'Write the Q3 summary for this project to report.md. Do this only once.\n');

  provider.script.push(
    toolReply('Writing the Q3 summary to report.md.', 'write', { path: 'report.md', content: REPORT }),
    emptyReply(),
  );
  mustPiDock(attempt, ['spawn', '--name', name, '--model', WORKER_MODEL], project);
  const id = mustPiDock(attempt, ['send', name, '--file', taskFile]).stdout.trim();
  await waitForLog(attempt, name, (events) => events.some((event) => event.event === 'done' && event.id === id));

  const reportFile = path.join(project, 'report.md');
  const { sessionFile } = await readManifest(attempt, name);
  return {
    name,
    id,
    project,
    reportFile,
    reportHash: await sha256(reportFile),
    sessionFile,
    sessionBytes: (await fs.readFile(sessionFile)).length,
    sessionHash: await sha256(sessionFile),
    setupEvents: (await logEvents(attempt, name)).length,
  };
}

export function prompt({ attempt }, state) {
  return `You are taking over from another operator. pi-dock is installed for you as this command; use it wherever pi-dock's documentation says \`pi-dock\`:

  node "${attempt.wrapper}"

Earlier, the previous operator asked the background agent \`${state.name}\` to write the Q3 summary for the project in ${state.project} to report.md. That task must run only once: running it again would duplicate the work. The operator kept the prompt id \`${state.id}\` but lost the client that was waiting for the result.

Your job:
1. Find out how that task ended and recover the agent's final answer to it.
2. Write your findings to ${path.join(attempt.work, 'answer.md')}: whether the task succeeded, the agent's final answer exactly as pi-dock reports it, and the report file's path and first line.
3. Leave \`${state.name}\` powered off, with its memory intact.

${evalRules(attempt, { operating: true })}
`;
}

// Memory kept: the session file still starts with the bytes it had after setup (a wake may
// append entries).
async function sessionKept(state) {
  let bytes;
  try {
    bytes = await fs.readFile(state.sessionFile);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  return bytes.length >= state.sessionBytes
    && createHash('sha256').update(bytes.subarray(0, state.sessionBytes)).digest('hex') === state.sessionHash;
}

// The booleans are measurements; whether the task succeeded is decided by reading answer.md and
// the trace. waitCommands only lists candidate commands for that review.
export async function measure({ attempt, provider }, state, trace) {
  const events = await logEvents(attempt, state.name);
  const after = events.slice(state.setupEvents);
  const manifest = await readManifest(attempt, state.name);
  const lastSpawned = events.findLast((event) => event.event === 'spawned');
  let answer = null;
  try {
    answer = await fs.readFile(path.join(attempt.work, 'answer.md'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  return {
    noResend: {
      pass: provider.requests.filter((request) => request.phase === 'solver').length === 0 && !after.some((event) => event.event === 'queued'),
      workerRequestsDuringSolver: provider.requests.filter((request) => request.phase === 'solver').length,
      queuedAfterSetup: after.filter((event) => event.event === 'queued').map((event) => event.id),
    },
    reportUnchanged: { pass: await sha256(state.reportFile).catch(() => null) === state.reportHash },
    memoryKept: { pass: manifest?.sessionFile === state.sessionFile && await sessionKept(state), manifestExists: manifest !== undefined },
    poweredOff: { pass: events.at(-1).event === 'stopped' && !processAlive(lastSpawned.pid), lastEvent: events.at(-1).event, runnerAlive: processAlive(lastSpawned.pid) },
    waitCommands: (trace?.tools ?? []).filter(({ tool, args }) => tool === 'bash' && args.command.includes(state.id)).map(({ args, isError, output }) => ({ command: args.command, isError, output })),
    answer,
  };
}
