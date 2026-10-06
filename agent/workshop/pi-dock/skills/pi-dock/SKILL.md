---
name: pi-dock
description: "Operating guide for the pi-dock CLI, which runs named, resident Pi agents in the background with durable sessions: spawn, send prompts and wait for results, read logs, stop and wake them with memory intact. Load it before running any pi-dock command or when you must delegate work to a long-lived background Pi agent."
---

# pi-dock

pi-dock keeps named Pi agents running after the shell that started them exits. Each agent is one
detached process hosting one Pi session; stopping it powers it off and keeps its identity, log and
session memory. Use it when work should outlive your own process, run in parallel with you, or
keep its memory across several prompts. For a single prompt you will wait on anyway, plain `pi -p`
is simpler.

Every command exits 0 on success and 1 on error, with the reason on stderr. Arguments are strict:
unknown options and extra arguments fail with the command's usage line, except `compact`, which
takes all remaining arguments (even `--help`) as instructions. Run `pi-dock --help` for the usage
of every command.

## Workflow

1. `pi-dock models [filter]` — list the `provider/id` refs you can pass to `--model`. Only models
   with configured credentials appear, with context, max-out, thinking and images columns. The
   filter is a case-insensitive substring of `provider/id`, or `provider-part/id-part` when it
   contains a slash; no match exits 1.
2. `pi-dock spawn --name <name> [--model <provider/id>] [--thinking <level>] [--x key[=value]]...`
   — create the agent in the current directory. It takes no prompt and normally starts
   idle, though an extension may already have started work. It prints
   `<name> <state> <provider/id>`.
   - Without `--model`, Pi's default model is used.
   - An unknown model (the error suggests matches) or one without credentials fails preflight,
     and nothing is created.
   - `--thinking` is `off|minimal|low|medium|high|xhigh|max` and is applied on every wake.
     Without it, Pi restores the session's saved level or picks its configured default. Levels
     the model does not support are clamped by Pi.
   - Names are lowercase `a-z0-9` segments joined by single `.`, `_` or `-`, at most 64
     characters, and not a Windows device name (`con`, `nul`, `com1`, …). Invalid names are
     rejected, never normalized. A name that exists fails with `agent already exists: <name>`.
3. `pi-dock send <name> --wait "<prompt>"` — give it work and block until the run ends. stdout
   carries only the final text; the prompt id goes to stderr.
4. `pi-dock logs <name>` and `pi-dock show <name>` — inspect what happened.
5. `pi-dock stop <name>...` — power agents off when you no longer need them.

## Prompts and results

- `send` never creates an agent; spawn first.
- The prompt is the remaining arguments joined by spaces, or with `--file <path>` the UTF-8
  contents of that file. Use exactly one of the two; empty prompts are rejected. `--` ends
  options, so the text may start with `-`. Prefer `--file` for long or multi-line prompts.
- Without `--wait`, `send` queues the prompt and prints its id (`p` + 12 hex). Prompts run one at
  a time, each after any work that extensions started while the agent was idle has settled.
- `pi-dock wait <name> <id>` waits for that prompt's run. It exits 0 when the run is done and
  prints its final text: the text after the run's last turn, or nothing if that turn produced
  none. Empty output does not mean the run wrote nothing: read `pi-dock logs <name>` for the text
  of its earlier turns. Exit 0 means this run ended, not that a collaboration is over (see
  `done` under Reading logs). A run that already ended is reported at once, so you can re-attach
  at any time.
- `send --wait` is `send` plus `wait`; its exit code is wait's. Keep the id from stderr: after an
  interruption, `wait <name> <id>` re-attaches.
- `wait` exits 1 with one of these reasons:
  - `prompt <id> failed: <reason>` — the run's last turn ended in an unrecovered provider error
    or abort. The agent stays on; you may send again.
  - `prompt <id> was dropped before it ran` — the agent shut down with the prompt still queued.
  - `agent <name> stopped during prompt <id>` or `agent <name> failed during prompt <id>: <reason>`.
  - `agent <name> stopped or crashed before prompt <id> finished` — the runner is gone, or a new
    runner booted after the prompt, so the prompt was lost.
  - `unknown prompt id: <id>`.
  - `agent <name> is not responding`.
- `wait` has no timeout, never wakes the agent and never retries. Ctrl-C only stops waiting; the
  run continues.

## States and waking

- `idle`, `running` or `compacting` while the runner answers; otherwise `stopped` after a stop,
  or `failed` after a crash or fatal error. `not-responding` means the runner did not answer in
  time: whether it is alive is unknown. The state is derived, never stored.
- `pi-dock ls` prints `name state model age` (age since creation, in its largest whole unit:
  s, m, h or d). `pi-dock show <name>` prints name, state, model, thinking (`-` when unset), flags
  (JSON array), cwd, session (the exact session file) and created, one key and value per line.
  Neither wakes the agent.
- Agents are resident: a runner never exits because work finished, only on stop or a crash.
- `start`, `send` and `compact` wake a stopped or failed agent with its memory intact. `start`
  prints `<name> <state> <provider/id>`; on an agent that is already on it just prints that.
- If the agent stops or crashes mid-request, `start`, `send` and `compact` report
  `agent <name> stopped or crashed during <cmd>` instead of waking or retrying.
- `pi-dock stop <name>...` takes one or more names and prints one line per name:
  `<name> stopped` only once its runner process has exited, or `<name> already stopped` /
  `<name> already failed` for an agent that is already off. The whole list is checked first: an
  invalid, unknown or repeated name fails and stops nothing. Then the agents are stopped one
  after another; a failure on one (e.g. not responding) is printed on stderr and the others are
  still stopped. The exit code is 1 if any failed. There is no `--all` and no pattern: list the
  names you mean.
- There is no destructive command: names, logs and sessions are never deleted by pi-dock.

## Changing an agent

- `pi-dock set <name> [--model <provider/id>] [--thinking <level>] [--x key[=value]]...` works
  only on a stopped or failed agent (`agent <name> is running — stop it first` otherwise). The
  model is preflighted like spawn's. `--x` replaces the entire flag list. The next wake applies
  the change; name, session, cwd and creation time never change.
- `--x key[=value]` flags are passed opaquely to extensions and are inert without them.
- `pi-dock compact <name> [instructions]` compacts the session. It requires an idle agent
  (`agent <name> is busy` otherwise, including while prompts are queued or another compaction,
  such as one an extension started, is in progress), wakes an off agent and leaves it on, and
  waits without a timeout for the result; Ctrl-C only stops waiting, not the compaction. All
  remaining arguments form the instructions. A failed compaction exits 1 with its reason.

## Reading logs

The log stores one NDJSON object per line, each with `ts`. `pi-dock logs <name>` prints each
event as `<ts> <event> [key=value]...`, with assistant text verbatim below it, indented two
spaces. `--tail <n>` prints only the last n events, `--raw` the stored NDJSON lines, and
`--follow` keeps printing new events until interrupted.

```
{event:"spawned", pid}             the runner booted
{event:"queued", id}               a prompt was accepted
{event:"run", id}                  its run started
{event:"turn", id?}                a model turn started
{event:"text", id?, text}          assistant text of a finished turn
{event:"external", id?, type}      a custom extension message of this type entered the context
{event:"extension_error", id?, extension, on, reason}
                                   an extension handler for event `on` threw; the agent goes on
{event:"done", id}                 the run finished (not terminal)
{event:"run_failed", id, reason}   the run ended in an unrecovered error or abort; agent stays on
{event:"compacted", id?}           a compaction finished, whoever started it: pi-dock compact,
                                   an extension, or Pi when the context grew too large
{event:"compact_failed", id?, reason}
                                   it failed; reason is Pi's message, e.g. "Compaction failed: …"
{event:"compact_cancelled", id?}   it was cancelled or aborted
{event:"dropped", ids}             queued prompts that never ran, just before stopped/failed
{event:"stopped", id?}  {event:"failed", id?, reason}
                                   terminal; id is the run they interrupted
```

- A compaction event's `id` is the run it happened in; it never ends that run.
- `done` proves that run ended, not that the agent is idle: queued prompts or extension work
  may keep it running. Use `ls` or `show` for the state.
- `done` of an initial mission does not end a collaboration: extension callbacks (e.g. pi-link
  replies) can start later work in the same agent. A team's conclusion is an application
  signal, such as an agreed final marker in a `text` event, and the artifact must still be
  verified. Never treat `done` or idle as "the team finished".
- For unattended teams, the README's Recipes give a deadline watchdog and a marker observer.
- Ids follow the run. Work that extensions steer into an active run (e.g. a pi-link message)
  carries that run's id; only work that extensions start while the agent is idle logs `turn` and
  `text` without an id.
- `external` follows the same id rule. `type` is the extension's message type (pi-link uses
  `link`); the content and sender are only in the session file (`show` prints its path). It
  means only that a custom message of this type entered the agent's context at that point: not
  what caused a turn, and not that the model acted on it. Absence proves nothing: extension
  prompts sent as user messages, and messages queued but lost to a stop or abort, log no
  `external`.
- `extension_error` names the extension file (`extension`) and the event its handler threw on
  (`on`), with the error message as `reason`. Pi catches the error and the agent keeps working:
  it is not a state change, and it follows the same id rule. Errors raised once the agent is
  stopping or failing are not logged, so `stopped`/`failed` always stays the last event.

## Recovery

- `agent <name> is not responding`: find the latest `{event:"spawned",pid}` in
  `pi-dock logs <name>`, terminate that PID externally, then run `pi-dock start <name>`. Do not
  retry in a loop.
- `agent <name> did not exit within 5s; terminate PID <pid> externally`: terminate that PID, then
  check `pi-dock ls`.
- `handshake failed for <name>`: a spawned or woken runner did not answer status within 20 s.
  Read the printed manifest and log diagnostics and the `last log` line, if present.

## Data

- `~/.pi/dock/<name>.json` is the manifest (identity and config) and `~/.pi/dock/<name>.log` the
  event log. The pipe is `\\.\pipe\pi-dock-<name>` on Windows, `~/.pi/dock/<name>.sock`
  elsewhere.
- Sessions live in Pi's session directory (`<agent dir>/sessions/--<cwd>--/`, where the agent dir
  is `~/.pi/agent` or `PI_CODING_AGENT_DIR`); `show` prints the exact file.

## Warnings

- Agents load `<cwd>/.pi` config and extensions WITHOUT asking for project trust. Spawn only in
  directories you trust.
- There are NO limits: no turn, time or cost cap. An agent runs until stop or a crash, and work
  that extensions deliver while it is idle (e.g. pi-link messages) is unbounded too. Stop agents
  you no longer need.
