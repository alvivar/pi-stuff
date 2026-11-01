// Shared plumbing for the pi-dock skill evaluation: paths, the scripted worker provider, the
// sandbox, the pi-dock wrapper, the solver launch, trace parsing and cleanup.
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILL_DIR = path.join(CHECKOUT, 'skills', 'pi-dock');
export const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');
export const RUNNER = path.join(CHECKOUT, 'src', 'runner.mjs');
// The solver runs the Pi CLI of the SDK pi-dock depends on, so both are the same version.
const SDK_DIR = path.join(CHECKOUT, 'node_modules', '@earendil-works', 'pi-coding-agent');
export const PI_CLI = path.join(SDK_DIR, 'dist', 'bundle', 'cli.js');
export const PI_PACKAGE = path.join(SDK_DIR, 'package.json');
// The solver keeps the real agent dir, so it uses the real auth file in place: a copy of an OAuth
// login could refresh it and invalidate the original. Resolved as Pi does (tilde, relative path,
// empty value), and made absolute here, before the solver's home and cwd change.
export const REAL_AGENT_DIR = path.resolve(getAgentDir());
export const WORKER_MODEL = 'faux/worker-1';
export const DEADLINE_MS = 10 * 60 * 1000;
// Attempts live outside the checkout, so the solver's own cwd is not inside pi-dock's files.
export const RUNS_ROOT = path.join(os.tmpdir(), 'pi-dock-skill-eval');

const normalize = (text) => text.replace(/\\/g, '/').toLowerCase();

// The protocol rules each prompt ends with. They are rules, not a sandbox: the trace hints below
// (readSource, readHarness) and a review of the trace check them.
export function evalRules(attempt, { operating }) {
  const forbidden = `do not read files in pi-dock's checkout (${CHECKOUT}) other than its skill, nor the evaluation's files in ${RUNS_ROOT} (fixture files, grading results, solver traces or other attempts)`;
  if (operating) {
    return `Rules: operate only on agents whose names start with \`${attempt.prefix}\`. You may read this attempt's project files and its agents' logs, sessions and manifests. Otherwise, ${forbidden}; running the pi-dock command above is fine.`;
  }
  return `Outside ${attempt.work}, ${forbidden}.`;
}

export async function sha256(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

// One attempt: its own home (dock, worker agent dir), solver cwd and a unique name prefix, since
// Windows pipes are global and a sandbox home does not separate them.
export async function createAttempt(puzzle) {
  const id = randomBytes(3).toString('hex');
  const dir = path.join(RUNS_ROOT, `${puzzle}-${id}`);
  const home = path.join(dir, 'home');
  const attempt = {
    puzzle,
    id,
    dir,
    home,
    agentDir: path.join(home, '.pi', 'agent'),
    dock: path.join(home, '.pi', 'dock'),
    work: path.join(dir, 'work'),
    solverSessions: path.join(dir, 'solver-sessions'),
    wrapper: path.join(dir, 'pi-dock.mjs'),
    prefix: `${puzzle}-${id}-`,
  };
  await fs.mkdir(attempt.agentDir, { recursive: true });
  await fs.mkdir(attempt.work, { recursive: true });
  await fs.mkdir(attempt.solverSessions, { recursive: true });
  return attempt;
}

// Every worker request is recorded with the phase it arrived in. Scripted replies are consumed in
// order; past the script, `fallback` answers and the request counts as unscripted.
export function startProvider() {
  const provider = { requests: [], script: [], phase: 'setup', fallback: textReply('(no scripted reply)') };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.once('end', () => {
      const request = JSON.parse(body);
      const scripted = provider.script.shift();
      provider.requests.push({ phase: provider.phase, scripted: scripted !== undefined, request });
      (scripted ?? provider.fallback)(res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    provider.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    provider.close = () => new Promise((done) => server.close(done));
    resolve(provider);
  }));
}

function sse(chunks) {
  return (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify({ id: 'faux', choices: [{ index: 0, ...chunk }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  };
}

export function textReply(text) {
  return sse([{ delta: { content: text } }, { delta: {}, finish_reason: 'stop' }]);
}

export function emptyReply() {
  return sse([{ delta: {}, finish_reason: 'stop' }]);
}

export function toolReply(text, name, args) {
  return sse([
    { delta: { content: text, tool_calls: [{ index: 0, id: `call_${randomBytes(4).toString('hex')}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } },
    { delta: {}, finish_reason: 'tool_calls' },
  ]);
}

// The worker profile: only the scripted provider, no user packages, extensions or skills.
export async function writeWorkerProfile(attempt, provider) {
  await fs.writeFile(path.join(attempt.agentDir, 'models.json'), JSON.stringify({
    providers: {
      faux: {
        baseUrl: provider.baseUrl,
        api: 'openai-completions',
        apiKey: 'faux',
        models: [{ id: 'worker-1', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 8192 }],
      },
    },
  }, null, 2));
  await fs.writeFile(path.join(attempt.agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'faux', defaultModel: 'worker-1', retry: { enabled: false } }, null, 2));
}

// The command the solver is given for pi-dock. It points pi-dock and its runners at the worker
// profile, then runs the checkout's CLI. The env is set before a dynamic import, which runs after it.
export async function writeWrapper(attempt) {
  await fs.writeFile(attempt.wrapper, [
    `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(attempt.agentDir)};`,
    "process.env.PI_OFFLINE = '1';",
    `await import(${JSON.stringify(pathToFileURL(path.join(CHECKOUT, 'bin', 'pi-dock.mjs')).href)});`,
    '',
  ].join('\n'));
}

function homeEnv(home) {
  const env = { ...process.env };
  // The harness itself runs inside a Pi session; the solver must not inherit its identity.
  for (const key of ['PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_CODING_AGENT', 'PI_CODING_AGENT_SESSION_DIR']) {
    delete env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: '',
    HOMEPATH: '',
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  };
}

// Runs pi-dock through the wrapper as the harness (fixtures and cleanup).
export function piDock(attempt, args, cwd = attempt.work) {
  const result = spawnSync(process.execPath, [attempt.wrapper, ...args], { cwd, env: homeEnv(attempt.home), encoding: 'utf8', windowsHide: true });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function mustPiDock(attempt, args, cwd) {
  const result = piDock(attempt, args, cwd);
  if (result.code !== 0) {
    throw new Error(`fixture: pi-dock ${args.join(' ')} exited ${result.code}: ${result.stderr}`);
  }
  return result;
}

// Sends a prompt and waits for its run to end. Not `send --wait`: piDock is synchronous, so the
// in-process provider could not answer while it blocks.
export async function sendAndSettle(attempt, name, text) {
  const id = mustPiDock(attempt, ['send', name, text]).stdout.trim();
  const events = await waitForLog(attempt, name, (log) => log.some((event) => event.id === id && ['done', 'run_failed'].includes(event.event)));
  const failed = events.find((event) => event.id === id && event.event === 'run_failed');
  if (failed) {
    throw new Error(`fixture: ${name}'s run ${id} failed: ${failed.reason}`);
  }
  return id;
}

export async function logEvents(attempt, name) {
  const text = await fs.readFile(path.join(attempt.dock, `${name}.log`), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

export async function waitForLog(attempt, name, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await logEvents(attempt, name);
    if (predicate(events)) {
      return events;
    }
    if (Date.now() > deadline) {
      throw new Error(`fixture: timed out waiting on ${name}'s log`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function readManifest(attempt, name) {
  try {
    return JSON.parse(await fs.readFile(path.join(attempt.dock, `${name}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

// Only ESRCH proves the process is gone; EPERM means it exists; anything else is an error.
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    if (error.code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

function commandLine(pid) {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`cannot read the command line of PID ${pid}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// True only for this checkout's runner hosting exactly that name (pi-dock launches
// `node <runner> --name <name> ...`).
function isOurRunner(cmd, name) {
  const normalized = cmd.replace(/\\/g, '/').toLowerCase();
  const runner = RUNNER.replace(/\\/g, '/').toLowerCase();
  const at = normalized.indexOf(runner);
  if (at === -1) {
    return false;
  }
  const rest = cmd.slice(at + runner.length).replace(/^"/, '').trimStart();
  return rest === `--name ${name}` || rest.startsWith(`--name ${name} `);
}

// Kills a process tree and reports whether the process is confirmed gone.
async function killTree(pid) {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  for (let tries = 0; tries < 50 && processAlive(pid); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { taskkill: result.status, stderr: result.stderr?.trim(), gone: !processAlive(pid) };
}

// Launches the solver once and resolves when it exits or the deadline kills its process tree.
// Without a thinking level, Pi's default applies.
export function runSolver(attempt, promptFile, model, thinking) {
  const args = [
    PI_CLI, '--print', '--mode', 'json',
    '--model', model, ...(thinking ? ['--thinking', thinking] : []),
    '--no-extensions', '--no-skills', '--no-context-files', '--skill', SKILL_DIR,
    '--tools', 'read,bash,edit,write',
    '--session-dir', attempt.solverSessions,
    `@${promptFile}`,
  ];
  // PI_OFFLINE: no package installs or catalog refreshes in the real profile; model and OAuth
  // requests are unaffected.
  const env = { ...homeEnv(attempt.home), PI_CODING_AGENT_DIR: REAL_AGENT_DIR, PI_OFFLINE: '1' };
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: attempt.work, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    let timedOut = false;
    // The kill is awaited on close, so its outcome (or error) is always in the result.
    let killing;
    const timer = setTimeout(() => {
      timedOut = true;
      killing = killTree(child.pid).then((outcome) => {
        if (!outcome.gone) {
          console.error(`solver PID ${child.pid} survived taskkill: ${JSON.stringify(outcome)}`);
        }
        return outcome;
      }, (error) => ({ error: error.stack }));
    }, DEADLINE_MS);
    child.on('error', reject);
    child.on('close', async (code) => {
      clearTimeout(timer);
      const kill = await killing;
      await fs.writeFile(path.join(attempt.dir, 'solver.jsonl'), Buffer.concat(out));
      await fs.writeFile(path.join(attempt.dir, 'solver.stderr.txt'), Buffer.concat(err));
      resolve({ code, timedOut, kill, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// What the solver did, from its JSON event stream: tool calls in order, its final text (the last
// assistant message, even if empty) and token usage (counted once per completed assistant
// message). readSkill: a successful read of this checkout's SKILL.md, or a command that looks
// like `pi-dock skill` (that form is a hint: confirm it in the trace). readSource and readHarness
// are hints only: false does not prove the solver did not look.
export async function readTrace(attempt) {
  const lines = (await fs.readFile(path.join(attempt.dir, 'solver.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const tools = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let finalText = '';
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'tool_execution_start') {
      tools.push({ id: event.toolCallId, tool: event.toolName, args: event.args });
    } else if (event.type === 'tool_execution_end') {
      const call = tools.find((entry) => entry.id === event.toolCallId);
      call.isError = event.isError;
      call.output = (event.result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('').slice(0, 2000);
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      for (const key of Object.keys(usage)) {
        usage[key] += event.message.usage?.[key] ?? 0;
      }
      finalText = (event.message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
    }
  }
  // What a call touches, with read paths resolved and the wrapper's own path (inside the attempt)
  // removed, since running it is allowed.
  const target = ({ tool, args }) => {
    const text = tool === 'read' ? path.resolve(attempt.work, args?.path ?? '') : tool === 'bash' ? args?.command ?? '' : '';
    return normalize(text).split(normalize(attempt.wrapper)).join('');
  };
  const readSkill = tools.some((call) =>
    (call.tool === 'read' && !call.isError && samePath(path.resolve(attempt.work, call.args?.path ?? ''), SKILL_FILE))
    || (call.tool === 'bash' && !call.isError && /pi-dock(\.mjs)?"?\s+skill(\s|$)/.test(call.args?.command ?? '')));
  const readSource = tools.some((call) => target(call).includes(normalize(CHECKOUT)) && !target(call).includes(normalize(SKILL_FILE)));
  const readHarness = tools.some((call) => /result\.json|fixture-task\.md|prompt\.md|solver\.jsonl/.test(target(call))
    || target(call).includes(normalize(path.dirname(fileURLToPath(import.meta.url))))
    || (target(call).includes(normalize(RUNS_ROOT)) && !target(call).includes(normalize(attempt.dir))));
  return { tools, readSkill, readSource, readHarness, finalText, usage };
}

// Stops what this attempt left on, after measurement: only names with the attempt's prefix, from
// the attempt's dock. A runner without a manifest (failed startup) is found through its log's
// spawned PID and terminated only if its command line is this checkout's runner for that name.
export async function cleanup(attempt) {
  const report = [];
  let entries = [];
  try {
    entries = await fs.readdir(attempt.dock);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  const ours = entries.filter((entry) => entry.startsWith(attempt.prefix));
  // Pipes are global, so another name could reach a real agent of the user's: left for a person.
  const outside = entries.filter((entry) => !entry.startsWith(attempt.prefix) && /\.(json|log)$/.test(entry));
  if (outside.length > 0) {
    report.push({ outsidePrefix: outside });
  }
  const names = ours.filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -5));
  if (names.length > 0) {
    const result = piDock(attempt, ['stop', ...names]);
    report.push({ stop: names, ...result });
  }
  for (const log of ours.filter((entry) => entry.endsWith('.log'))) {
    const name = log.slice(0, -4);
    const spawned = (await logEvents(attempt, name)).findLast((event) => event.event === 'spawned');
    if (spawned && processAlive(spawned.pid)) {
      const cmd = commandLine(spawned.pid);
      if (isOurRunner(cmd, name)) {
        report.push({ kill: name, pid: spawned.pid, ...await killTree(spawned.pid) });
      } else {
        report.push({ notOurs: name, pid: spawned.pid, cmd });
      }
    }
  }
  return report;
}
