// P2 — roles and tools on existing agents, one of them broken. The reader is on (set needs it
// off); the editor is off with a stored tool typo (`wirte`) the previous operator did not notice,
// so its next wake fails with `tools not found`. The solver must configure both by set (not by
// recreating them), delete the role files (the prompt is stored as content), wake them from
// another directory, and leave both off. The scripted worker only answers; what is measured is
// what each agent was given: its stored config and the system prompt and tools it was sent.
import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { evalRules, WORKER_MODEL, logEvents, mustPiDock, processAlive, readManifest, sendAndSettle, textReply } from './lib.mjs';

async function snapshot(attempt, name) {
  const manifest = await readManifest(attempt, name);
  const bytes = await fs.readFile(manifest.sessionFile);
  return {
    manifest,
    sessionBytes: bytes.length,
    sessionHash: createHash('sha256').update(bytes).digest('hex'),
    setupEvents: (await logEvents(attempt, name)).length,
  };
}

async function sessionKept(before) {
  let bytes;
  try {
    bytes = await fs.readFile(before.manifest.sessionFile);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  return bytes.length >= before.sessionBytes
    && createHash('sha256').update(bytes.subarray(0, before.sessionBytes)).digest('hex') === before.sessionHash;
}

export async function setup({ attempt, provider }) {
  const reader = `${attempt.prefix}reader`;
  const editor = `${attempt.prefix}editor`;
  const project = path.join(attempt.work, 'project');
  const roles = path.join(attempt.work, 'roles');
  const elsewhere = path.join(attempt.work, 'elsewhere');
  await fs.mkdir(project);
  await fs.mkdir(roles);
  await fs.mkdir(elsewhere);
  await fs.writeFile(path.join(project, 'plan.md'), '# Plan\n\n- ship the beta\n');
  const marker = randomBytes(3).toString('hex');
  const readerRole = `You are the project's reader (role ${marker}-R). Read files and answer questions about them; never modify anything.\n`;
  const editorRole = `You are the project's editor (role ${marker}-E). Make the file changes you are asked for, and nothing else.\n`;
  await fs.writeFile(path.join(roles, 'reader.md'), readerRole);
  await fs.writeFile(path.join(roles, 'editor.md'), editorRole);

  // Both agents worked once before, so each has a session (memory) to keep.
  provider.script.push(textReply('Noted.'), textReply('Noted.'));
  mustPiDock(attempt, ['spawn', '--name', reader, '--model', WORKER_MODEL], project);
  await sendAndSettle(attempt, reader, 'Remember: the beta ships on Friday.');
  mustPiDock(attempt, ['spawn', '--name', editor, '--model', WORKER_MODEL, '--tools', 'read,write'], project);
  await sendAndSettle(attempt, editor, 'Remember: the beta ships on Friday.');
  mustPiDock(attempt, ['stop', editor]);
  mustPiDock(attempt, ['set', editor, '--tools', 'read,wirte']);

  provider.fallback = textReply('Ready.');
  return {
    reader,
    editor,
    project,
    roles,
    elsewhere,
    readerRole,
    editorRole,
    readerMarker: `${marker}-R`,
    editorMarker: `${marker}-E`,
    before: { [reader]: await snapshot(attempt, reader), [editor]: await snapshot(attempt, editor) },
  };
}

export function prompt({ attempt }, state) {
  return `You are taking over from another operator. pi-dock is installed for you as this command; use it wherever pi-dock's documentation says \`pi-dock\`:

  node "${attempt.wrapper}"

Two background agents already work on the project in ${state.project}: \`${state.reader}\` and \`${state.editor}\`. Both have memory of earlier work that must be kept, so do not recreate them.

Your job:
1. Give \`${state.reader}\` the role in ${path.join(state.roles, 'reader.md')}, exactly the tools read and grep, and thinking level low.
2. Give \`${state.editor}\` the role in ${path.join(state.roles, 'editor.md')}. The previous operator says it already has the tools it needs (reading and writing files), so keep whatever of its configuration works. If something keeps an agent from starting, find out why and repair it without recreating the agent.
3. Delete the directory ${state.roles}; it is temporary.
4. Working from the directory ${state.elsewhere}, ask each agent "Reply with a short confirmation that you are ready." and wait for both answers.
5. Write both answers, and anything that went wrong and how you dealt with it, to ${path.join(attempt.work, 'answer.md')}.
6. Leave both agents powered off.

${evalRules(attempt, { operating: true })}
`;
}

function sameSet(actual, expected) {
  return Array.isArray(actual) && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

// The booleans are measurements; success is decided by reading answer.md and the trace.
export async function measure({ attempt, provider }, state) {
  const sent = provider.requests.filter((entry) => entry.phase === 'solver').map(({ request }) => ({
    system: typeof request.messages[0]?.content === 'string' ? request.messages[0].content : JSON.stringify(request.messages[0]?.content ?? ''),
    tools: (request.tools ?? []).map((tool) => tool.function.name).sort(),
  }));
  const sentTo = (marker) => sent.filter((entry) => entry.system.includes(marker));
  const agent = async (name, expected) => {
    const before = state.before[name];
    const manifest = await readManifest(attempt, name);
    const events = await logEvents(attempt, name);
    const lastSpawned = events.findLast((event) => event.event === 'spawned');
    return {
      config: {
        pass: manifest?.systemPrompt === expected.role && sameSet(manifest?.tools, expected.tools) && manifest?.thinking === expected.thinking,
        systemPromptMatches: manifest?.systemPrompt === expected.role,
        tools: manifest?.tools,
        thinking: manifest?.thinking,
      },
      identityAndMemoryKept: {
        pass: manifest !== undefined && manifest.sessionFile === before.manifest.sessionFile && manifest.cwd === before.manifest.cwd && manifest.startedAt === before.manifest.startedAt && manifest.model === before.manifest.model && await sessionKept(before),
      },
      delivered: {
        // The marker only correlates a request with its agent; the role text itself must be in
        // the system prompt the SDK built (it appends context such as the cwd).
        pass: sentTo(expected.marker).length > 0 && sentTo(expected.marker).every((entry) => entry.system.includes(expected.role.trim()) && sameSet(entry.tools, expected.tools)),
        requests: sentTo(expected.marker).length,
        toolsSent: [...new Set(sentTo(expected.marker).map((entry) => entry.tools.join(',')))],
      },
      poweredOff: { pass: ['stopped', 'failed'].includes(events.at(-1).event) && !processAlive(lastSpawned.pid), lastEvent: events.at(-1).event },
      eventsAfterSetup: events.slice(before.setupEvents).map((event) => event.event + (event.reason ? `: ${event.reason}` : '')),
    };
  };
  let answer = null;
  try {
    answer = await fs.readFile(path.join(attempt.work, 'answer.md'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  const dockNames = (await fs.readdir(attempt.dock)).filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -5)).sort();
  return {
    reader: await agent(state.reader, { role: state.readerRole, tools: ['read', 'grep'], thinking: 'low', marker: state.readerMarker }),
    editor: await agent(state.editor, { role: state.editorRole, tools: ['read', 'write'], thinking: undefined, marker: state.editorMarker }),
    // Measured at the end; whether roles/ went before the wake is read in the trace.
    rolesDeleted: { pass: await fs.access(state.roles).then(() => false, (error) => { if (error.code === 'ENOENT') { return true; } throw error; }) },
    noOtherAgents: { pass: JSON.stringify(dockNames) === JSON.stringify([state.editor, state.reader].sort()), dockNames },
    unmarkedRequests: sent.filter((entry) => !entry.system.includes(state.readerMarker) && !entry.system.includes(state.editorMarker)).length,
    answer,
  };
}
