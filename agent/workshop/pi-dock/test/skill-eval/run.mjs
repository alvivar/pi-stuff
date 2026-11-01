// Evaluates whether an AI operates pi-dock correctly with its skill. One attempt of one puzzle:
//
//   node test/skill-eval/run.mjs <p1..p5> <provider/id> [thinking]   paid: a real solver model
//   node test/skill-eval/run.mjs <p1..p5> --no-solver                free: builds and measures the fixture only
//
// The solver is one `pi --print` run with only this checkout's skill; the agents it operates
// answer from a local scripted provider, so they make no model calls. Each attempt lives in
// <tmp>/pi-dock-skill-eval/<puzzle>-<id>/ with its own home, dock and worker profile; the solver
// uses the real agent dir for its model's credentials. result.json there has the measurements;
// whether the solver succeeded is decided by reading work/answer.md and the trace, not the
// booleans alone. Windows only (process checks use taskkill and PowerShell).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PI_PACKAGE, REAL_AGENT_DIR, SKILL_FILE, cleanup, createAttempt, readTrace, runSolver, sha256, startProvider, writeWorkerProfile, writeWrapper } from './lib.mjs';

// Strict, so a mistyped dry-run flag cannot start a paid run.
const args = process.argv.slice(2);
const usage = 'usage: node test/skill-eval/run.mjs <p1..p5> (<provider/id> [thinking] | --no-solver)';
const noSolver = args[1] === '--no-solver';
if (!/^p[1-5]$/.test(args[0] ?? '') || (noSolver ? args.length !== 2 : args.length < 2 || args.length > 3 || args[1].startsWith('-') || !args[1].includes('/'))) {
  console.error(usage);
  process.exit(1);
}
if (process.platform !== 'win32') {
  console.error('skill-eval runs on Windows only');
  process.exit(1);
}
const [puzzleName, model, thinking] = args;
// Pi only warns about an unknown level and goes on without it, so check before a paid run.
if (thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) {
  console.error(`unknown thinking level: ${thinking}\n${usage}`);
  process.exit(1);
}
// --no-context-files does not drop the global SYSTEM.md / APPEND_SYSTEM.md, which would give the
// solver instructions besides the skill without any trace of them.
if (!noSolver) {
  for (const file of ['SYSTEM.md', 'APPEND_SYSTEM.md']) {
    const target = path.join(REAL_AGENT_DIR, file);
    if (await fs.access(target).then(() => true, (error) => { if (error.code === 'ENOENT') { return false; } throw error; })) {
      console.error(`${target} exists: the solver would load it besides the skill; move it aside to run the evaluation`);
      process.exit(1);
    }
  }
}
const puzzle = await import(`./${puzzleName}.mjs`);

const skillHash = await sha256(SKILL_FILE);
const attempt = await createAttempt(puzzleName);
const provider = await startProvider();
const ctx = { attempt, provider };
const result = {
  puzzle: puzzleName,
  attempt: attempt.id,
  dir: attempt.dir,
  noSolver,
  model: noSolver ? undefined : model,
  thinking: noSolver ? undefined : thinking ?? null,
  pi: JSON.parse(await fs.readFile(PI_PACKAGE, 'utf8')).version,
  skillSha256: skillHash,
};
try {
  await writeWorkerProfile(attempt, provider);
  await writeWrapper(attempt);
  const state = await puzzle.setup(ctx);
  result.state = state;
  const promptFile = path.join(attempt.dir, 'prompt.md');
  await fs.writeFile(promptFile, puzzle.prompt(ctx, state));

  provider.phase = 'solver';
  let trace;
  if (!noSolver) {
    result.solver = await runSolver(attempt, promptFile, model, thinking);
    trace = await readTrace(attempt);
    result.trace = {
      readSkill: trace.readSkill,
      readSource: trace.readSource,
      readHarness: trace.readHarness,
      usage: trace.usage,
      finalText: trace.finalText,
      tools: trace.tools.map(({ tool, args: toolArgs, isError, output }) => ({ tool, isError, args: tool === 'bash' ? toolArgs.command : toolArgs?.path, output })),
    };
  }
  // The skill the solver read must be the one recorded.
  result.skillUnchanged = await sha256(SKILL_FILE) === skillHash;
  provider.phase = 'measure';
  result.checks = await puzzle.measure(ctx, state, trace);
} catch (error) {
  result.error = error.stack;
} finally {
  // A cleanup failure is recorded, not thrown, so the result and the evidence are kept.
  provider.phase = 'cleanup';
  try {
    result.cleanup = await cleanup(attempt);
  } catch (error) {
    result.cleanupError = error.stack;
  }
  // What each worker was sent: system prompt, tool names and the last message.
  result.workerRequests = provider.requests.map(({ phase, scripted, request }) => ({ phase, scripted, system: request.messages[0]?.role === 'system' ? request.messages[0].content : undefined, tools: (request.tools ?? []).map((tool) => tool.function.name), lastMessage: request.messages.at(-1) }));
  await fs.writeFile(path.join(attempt.dir, 'result.json'), JSON.stringify(result, null, 2));
  await provider.close();
}

// Every `pass` in the checks, one level of nesting deep (P2 checks each agent).
const summary = {};
for (const [key, value] of Object.entries(result.checks ?? {})) {
  if (value && typeof value === 'object' && 'pass' in value) {
    summary[key] = value.pass;
  } else if (value && typeof value === 'object') {
    for (const [inner, check] of Object.entries(value)) {
      if (check && typeof check === 'object' && 'pass' in check) {
        summary[`${key}.${inner}`] = check.pass;
      }
    }
  }
}
console.log(JSON.stringify({ dir: attempt.dir, error: result.error?.split('\n')[0], cleanupError: result.cleanupError?.split('\n')[0], cleanup: result.cleanup, solver: result.solver, readSkill: result.trace?.readSkill, readSource: result.trace?.readSource, readHarness: result.trace?.readHarness, skillUnchanged: result.skillUnchanged, usage: result.trace?.usage, checks: summary }, null, 2));
