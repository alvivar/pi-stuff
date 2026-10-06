# pi-dock

Keep named Pi agents running in the background. `pi-dock spawn` starts an agent that outlives
the shell that created it; you hand it prompts, wait for or read its results, power it off, and
wake it later with its memory intact.

Each agent is one detached process hosting one Pi session, identified by a name you choose:

- **Delegate and walk away**: send a long task, close the terminal, read the result later.
- **Several agents side by side**: residents in different directories or with different models,
  working while you do something else.
- **Memory across prompts**: a stopped agent keeps its session; the next prompt continues it.
- **Teams over pi-link**: a docked agent can join [pi-link](https://www.npmjs.com/package/pi-link)
  and talk to your other terminals.

> [!WARNING]
> **Trusted directories only.** An agent loads `<cwd>/.pi` config and extensions **without**
> Pi's project-trust prompt. Spawn agents only in directories you trust.
>
> **No limits.** There is no turn, time or cost cap. An agent runs until you stop it or it
> crashes, and work that extensions deliver while it is idle (e.g. pi-link messages) is
> unbounded too. Stop agents you no longer need.

---

## Contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Recipes](#recipes)
- [For AI agents](#for-ai-agents)
- [Data locations](#data-locations)
- [Status and limitations](#status-and-limitations)

---

## Prerequisites

- Node.js **22.19 or later** (required by the Pi SDK).
- Pi set up with credentials for at least one model. pi-dock runs agents with its own copy of the
  Pi SDK (`@earendil-works/pi-coding-agent` 0.99.x) but uses your Pi agent directory
  (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) for credentials, settings, models and extensions.
  `pi-dock models` lists only the models whose credentials are configured.
- The `pi` command is needed only to set up credentials and to install the skill (below).

## Install

pi-dock is not on npm. Install it from a checkout of this directory:

```bash
cd path/to/pi-dock
npm ci             # dependencies, exactly as locked
npm install -g .   # puts the pi-dock command on PATH
pi-dock --help
```

`npm install -g .` links the global command to the checkout, so keep the checkout and its
`node_modules` in place. Remove the command with `npm uninstall -g pi-dock`.

pi-dock is also a Pi package that contains only the pi-dock skill (no extensions). To make Pi
agents aware of it:

```bash
pi install path/to/pi-dock   # Pi loads the local package in place; nothing is copied
pi remove path/to/pi-dock    # undo
```

## Quick start

```bash
pi-dock models haiku
pi-dock spawn --name w1 --model anthropic/claude-haiku-4-5
pi-dock send w1 --wait "Summarize README.md in three bullets"
pi-dock logs w1 --tail 5
pi-dock show w1
pi-dock stop w1
```

- `models haiku` lists the matching `provider/id` refs you can use, with context, max-out,
  thinking and images columns.
- `spawn` creates `w1` in the current directory and prints `w1 idle anthropic/claude-haiku-4-5`.
  The agent waits idle; spawn never takes a prompt.
- `send --wait` queues the prompt, prints its id (`p` + 12 hex) on stderr, and prints the run's
  final text on stdout once it is done.
- `logs` shows what happened; `show` prints the agent's name, state, model, thinking, flags, cwd,
  session file and creation time.
- `stop` powers the agent off and prints `w1 stopped`. `pi-dock send w1 "…"` or
  `pi-dock start w1` wakes it again, with the conversation intact.

Every command exits 0 on success and 1 on error, with the reason on stderr. Options and
arguments are strict: anything unknown fails with the command's usage line. The exception is
`compact`, which takes all remaining arguments as instructions: `pi-dock compact w1 --help`
compacts `w1` with the instructions `--help`. For usage, run the top-level `pi-dock --help`.

## Commands

| Command | What it does |
| --- | --- |
| `spawn --name <name> [--model <provider/id>] [--thinking <level>] [--x key[=value]]...` | Create an idle agent in the current directory |
| `send <name> [--wait] [--file <path>] [--] [text...]` | Queue a prompt and print its id; `--wait` also waits for the result |
| `wait <name> <id>` | Wait for a prompt's run and print its final text |
| `start <name>` | Wake a stopped or failed agent |
| `stop <name>...` | Power agents off and confirm their processes exited |
| `ls` | List agents: `name state model age` |
| `show <name>` | Print one agent's details, one key and value per line |
| `logs <name> [--tail <n>] [--raw] [--follow]` | Print the agent's event log |
| `set <name> [--model <provider/id>] [--thinking <level>] [--x key[=value]]...` | Change a powered-off (stopped or failed) agent's configuration |
| `compact <name> [instructions]` | Compact an idle agent's session |
| `models [filter]` | List the models you can use |
| `skill` | Print the operating guide for AI agents |

`pi-dock --help` shows usage and the essentials. The full operating contract (every outcome,
message and rule) is in `pi-dock skill`.

---

## How it works

### Resident agents

An agent is resident: its process never exits because work finished, only on `stop` or a crash.
`ls` and `show` report its state: `idle`, `running` or `compacting` while it is on; `stopped`
after a stop; `failed` after a crash; `not-responding` when its process did not answer in time,
which does not tell whether it is alive. Neither wakes it.

`stop` is a power-off, not a delete. The name, configuration, log and session survive, and
`start`, `send` and `compact` wake the agent with its memory. pi-dock has no command that
deletes an agent.

`pi-dock stop w1 w2 w3` stops a team. It checks the whole list first, so an invalid, unknown or
repeated name stops nothing. Then it stops the agents one after another and prints one line per
name (`w1 stopped`, `w2 already stopped`); a failure on one goes to stderr, the others are still
stopped, and the exit code is 1. There is no `--all` and no pattern.

`send` never creates an agent, so a typo in the name fails instead of starting a new one.

### Getting results

- `pi-dock send <name> --wait "<prompt>"` blocks until the run ends: stdout carries only the
  final text, and the prompt id goes to stderr.
- Without `--wait`, `send` prints the id at once; `pi-dock wait <name> <id>` waits for it later,
  and reports a run that already ended at once. `wait` has no timeout and never wakes the
  agent; Ctrl-C only stops waiting.
- When the run fails, the prompt is dropped by a shutdown, or the agent stops or crashes,
  `wait` exits 1 with the reason.
- `pi-dock logs <name>` shows lifecycle and assistant-turn events (`queued`, `run`, `turn`,
  `text`, `done`, …); tool calls and the full conversation are in the session file. `--follow`
  keeps watching, and `--raw` prints the stored NDJSON.

Long prompts are easier with `--file prompt.md`. Prompts run one at a time, in order.

### Models and thinking

- `--model provider/id` takes a ref from `pi-dock models`. Without it, Pi's default model is
  used. An unknown model (the error suggests matches) or one without credentials fails before
  anything is created.
- `--thinking off|minimal|low|medium|high|xhigh|max` is applied on every wake. Without it, Pi
  restores the session's saved level or uses its configured default; levels the model does not
  support are clamped by Pi.
- `pi-dock set` changes model, thinking and extension flags, only while the agent is powered
  off (stopped or failed); the next wake applies them.

### Extension flags and pi-link

`--x key[=value]` passes a flag to the extensions the agent loads, the same as `--key value` on
the `pi` command line. pi-dock does not interpret them, and they do nothing without the
extension that defines them. `set --x` replaces the whole list.

With pi-link installed in Pi, this spawns an agent that joins the link and requests the link
name `reviewer` (pi-link may suffix a taken name, e.g. `reviewer-2`):

```bash
pi-dock spawn --name reviewer --x link --x link-name=reviewer
```

Messages from other terminals then reach the agent as they reach any pi-link terminal. Their
turns appear in the agent's log, and they fall under the "no limits" warning above.

### Compaction

`pi-dock compact <name> [instructions]` compacts the agent's session. The agent must be idle
(no run, no queued prompts); a stopped agent is woken first and stays on. It waits without a
timeout for the result and exits 1 with the reason when compaction fails (e.g.
`Nothing to compact (session too small)`). The log records the outcome of every compaction
(`compacted`, `compact_failed` or `compact_cancelled`), including those an extension or Pi
itself starts.

### Recovery

- **`agent <name> is not responding`**: a request to the agent timed out. Find the latest
  `spawned pid=<pid>` line in `pi-dock logs <name>`, terminate that process, then run
  `pi-dock start <name>`.
- **`agent <name> did not exit within 5s; terminate PID <pid> externally`**: `stop` asked the
  agent to exit and it did not. Terminate that process, then check `pi-dock ls`.
- **`handshake failed for <name>`**: a spawned or woken agent did not answer within 20 s. The
  printed diagnostics include the last log line, if any.

> [!CAUTION]
> PIDs are reused by the operating system. Before terminating one, make sure it is still that
> agent's process: its command line contains `runner.mjs --name <name>`.

## Recipes

pi-dock has no limits and no notion of a team being finished; both belong to the application.
These two small Node scripts cover them. Node is already required by pi-dock and behaves the same
on Windows and Unix, where a shell script would not. Both call `pi-dock` from your `PATH`.

### Watchdog for unattended runs

Before spawning anything, write the roster: the exact names the run will use. Never stop by
pattern; a pattern can match agents that are not part of the run.

```bash
printf '%s\n' lead coder reviewer > roster.txt
```

In PowerShell: `Set-Content roster.txt lead, coder, reviewer`.

`watchdog.mjs` waits for an absolute deadline, then stops every agent in the roster and records
each result in `watchdog.log`:

```js
// node watchdog.mjs <ISO deadline> <roster file>
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const [deadlineText, rosterFile] = process.argv.slice(2);
const deadline = Date.parse(deadlineText);
const roster = readFileSync(rosterFile, 'utf8').split(/\s+/).filter(Boolean);
const badName = roster.find((name) => !/^[a-z0-9._-]+$/.test(name));
if (Number.isNaN(deadline) || roster.length === 0 || badName !== undefined) {
  throw new Error('usage: node watchdog.mjs <ISO deadline> <roster file of agent names>');
}
const record = (text) => appendFileSync('watchdog.log', `${new Date().toISOString()} ${text}\n`);
record(`armed until ${new Date(deadline).toISOString()} for ${roster.join(' ')}`);

// Poll the wall clock: one long timer cannot exceed ~24.8 days and may not count host sleep.
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, deadline - Date.now())));
}
// One stop per name, so a name that was never spawned cannot keep the others running.
let failed = false;
for (const name of roster) {
  const stop = spawnSync(`pi-dock stop ${name}`, { shell: true, encoding: 'utf8' });
  const output = stop.error?.message ?? `${stop.stdout}${stop.stderr}`.trim();
  record(`${name}: exit ${stop.status}: ${output}`);
  failed ||= stop.status !== 0;
}
process.exitCode = failed ? 1 : 0;
```

Start it as its own process before launching the team, so it does not depend on the
orchestrator:

```bash
nohup node watchdog.mjs 2026-10-02T18:00:00Z roster.txt >/dev/null 2>&1 &
```

In PowerShell:

```powershell
Start-Process node -WindowStyle Hidden -ArgumentList watchdog.mjs, 2026-10-02T18:00:00Z, roster.txt
```

The watchdog never kills a process: PIDs are reused, so a failed stop is for a person to resolve
with [Recovery](#recovery), using `watchdog.log`. Know its limits:

- A stop can be slow (up to about 8 s for an agent that misbehaves) or fail.
- On the same machine it cannot keep the deadline if the host sleeps, hibernates or crashes,
  and it is itself a process that can be killed.
- A run that finishes early can stop its own agents; at the deadline the watchdog then records
  `already stopped`.

### Observer for team completion

`done` and `idle` do not mean a team has finished: pi-link messages can start more work at any
time. Agree on a final marker with the lead instead, fresh for every mission, e.g. "when, and
only when, the result is complete, end your reply with the line `TEAM-DONE-m42`". `observe.mjs`
polls the lead's raw log every 15 s until a `text` event ends with that line. A marker only
mentioned mid-reply does not count. Because the marker is unique to the mission, the observer
can start, or restart, at any time, even after the lead has finished:

```js
// node observe.mjs <lead> <marker>
import { execSync } from 'node:child_process';

const [lead, marker] = process.argv.slice(2);
if (!/^[a-z0-9._-]+$/.test(lead ?? '') || !marker) {
  throw new Error('usage: node observe.mjs <lead agent> <marker>');
}
// The whole log is read each time, so it is not capped (Node's default is 1 MiB of output).
const read = () => execSync(`pi-dock logs ${lead} --raw`, { encoding: 'utf8', maxBuffer: Infinity })
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));

for (;;) {
  const events = read();
  const final = events.find((event) => event.event === 'text'
    && event.text.trimEnd().split(/\r?\n/).at(-1).trim() === marker);
  if (final) {
    console.log(final.text);
    break;
  }
  const external = events.filter((event) => event.event === 'external').length;
  console.error(`${new Date().toISOString()} waiting; ${external} extension messages logged`);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
```

The marker is the team's claim, not proof: check the artifact before you trust it (here
`npm test` stands for your own check), then stop the roster.

```bash
node observe.mjs lead TEAM-DONE-m42 && npm test && pi-dock stop $(cat roster.txt)
```

In Windows PowerShell 5.1, which has no `&&`, check `$?` as well as the exit code: a command
that cannot run at all (e.g. `npm` not found) leaves `$LASTEXITCODE` at the previous `0`.

```powershell
node observe.mjs lead TEAM-DONE-m42
if ($? -and $LASTEXITCODE -eq 0) {
  npm test
  if ($? -and $LASTEXITCODE -eq 0) { pi-dock stop (Get-Content roster.txt) }
}
```

The `external` count is only a sign of activity: it counts extension messages (for pi-link,
`external type=link`) that entered the lead's context, not messages the lead acted on. The
whole log is read on every poll, which costs memory for a very long-lived lead.

## For AI agents

`pi-dock skill` prints the pi-dock operating guide: workflow, prompt ids and `wait` outcomes,
states and waking, changing agents, reading logs, recovery and the warnings. `--help` ends by
telling AI agents to read it.

Installed as a Pi package (see [Install](#install)), the same guide is the `pi-dock` skill, so Pi
agents load it on their own when a task involves pi-dock. For other AI tools, have them run
`pi-dock skill` first.

## Data locations

| What | Where |
| --- | --- |
| Manifest (identity and configuration) | `~/.pi/dock/<name>.json` |
| Event log (NDJSON) | `~/.pi/dock/<name>.log` |
| Control pipe | `\\.\pipe\pi-dock-<name>` on Windows, `~/.pi/dock/<name>.sock` elsewhere |
| Session | Pi's session directory, `<agent dir>/sessions/--<cwd>--/`; `pi-dock show <name>` prints the exact file |

Names are lowercase `a-z0-9` segments joined by single `.`, `_` or `-`, at most 64 characters,
and not a Windows device name such as `con` or `nul`.

## Status and limitations

- **Version 0.2.0**, unpublished (`"private": true`).
- **Windows** is verified: the regression suite on every change, and the paid end-to-end smoke
  test against a real model. **Unix** (sockets, signals) has been inspected but not run.
- **Lockfile:** `package-lock.json` reproduces this checkout's dependencies. It does not pin the
  transitive dependencies of anyone who installs pi-dock some other way.
- Design and contracts: [`DESIGN.md`](DESIGN.md). Tests: `node test/regression.mjs` (free, no
  model calls); `node test/smoke.mjs <provider/id> [thinking]` makes real, paid calls to that
  model, with Pi's default thinking unless a level is given.
