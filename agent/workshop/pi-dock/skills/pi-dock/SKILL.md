---
name: pi-dock
description: "Operating guide for the pi-dock CLI, which runs named, resident Pi agents in the background that keep their session memory across stop and wake. Load it before running any pi-dock command or delegating work to a long-lived background Pi agent."
---

# pi-dock

pi-dock keeps named Pi agents running after the shell that started them exits: each agent is one
detached process hosting one Pi session, and stopping it keeps its identity, log and memory. Use
it when work should outlive your process, run in parallel with you, or keep its memory across
prompts. For a single prompt you will wait on anyway, plain `pi -p` is simpler.

Commands here are written as `pi-dock …`. If `pi-dock` is not on your PATH (Pi installs
packages without putting their commands there), run the package's `bin/pi-dock.mjs` with Node
and the same arguments instead: `node "<this skill's directory>/../../bin/pi-dock.mjs" …`.

Every command exits 0 on success and 1 on error, with the reason on stderr. Arguments are strict:
unknown options and extra arguments fail with the command's usage line, except `compact`, which
takes all remaining arguments (even `--help`) as instructions. Run `pi-dock --help` for the usage
of every command.

## Warnings

- Agents load `<cwd>/.pi` config and extensions WITHOUT asking for project trust. Spawn only in
  directories you trust.
- There are NO limits: no turn, time or cost cap. An agent runs until stop or a crash, and work
  that extensions deliver while it is idle (e.g. pi-link messages) is unbounded too. Stop agents
  you no longer need.

## Workflow

1. `pi-dock models [filter]` — when you need to choose a model: lists the `provider/id` refs
   that have configured credentials. The filter is a case-insensitive substring of
   `provider/id`, or `provider-part/id-part`.
2. `pi-dock spawn --name <name> [--fork <path|id>] [--model <provider/id>] [--thinking <level>]
   [--system-prompt <file>] [--tools <a,b> | --no-tools] [--x key[=value]]...`
   — create the agent in the current directory. It takes no prompt and prints
   `<name> <state> <provider/id>`.
   - Without `--model` or `--fork`, Pi's default model is used. An unknown model (the error suggests
     matches) or one without credentials fails preflight, and nothing is created.
   - `--fork <path|id>` starts from a copy of that session, as `pi --fork`: a path (it has `/`
     or `\`, or ends in `.jsonl`) or an exact session id. Take another agent's session file
     from `show`; your own is `$PI_SESSION_FILE`. Without `--model`, the source's model is used
     if it has credentials; thinking and tools follow the session unless set; the system prompt
     is not inherited. A fork of your own session ends at your unanswered `pi-dock spawn` call,
     which it sees as failed: say in its first prompt that it is the fork. See
     [Forking a session](../../README.md#forking-a-session).
   - `--thinking` is `off|minimal|low|medium|high|xhigh|max` and is applied on every wake.
     Without it, the session's saved level or Pi's default applies.
   - Names are lowercase `a-z0-9` segments joined by single `.`, `_` or `-`, at most 64
     characters; Windows device names are reserved. Invalid names are rejected, never
     normalized. A name that exists fails with `agent already exists: <name>`.
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
  a time, in order; `send` queues work rather than interrupting ongoing extension work.
- `pi-dock wait <name> <id>` waits for that prompt's run. On success it prints the text of the
  run's last turn, or nothing if that turn produced none; the text of earlier turns is in
  `pi-dock logs <name>`. A run that already ended is reported at once, so you can re-attach at
  any time. Exit 0 means this run ended, not that a collaboration is over (see Reading logs).
- `send --wait` is `send` plus `wait`; its exit code is wait's. Keep the id from stderr: after an
  interruption, `wait <name> <id>` re-attaches without sending again.
- `wait` has no timeout, never wakes the agent and never retries. Ctrl-C only stops waiting; the
  run continues.
- `wait` exits 1 with one of these reasons:
  - `prompt <id> failed: <reason>` — the run ended in an unrecovered provider error or abort.
    The agent stays on; you may send again.
  - `prompt <id> was dropped before it ran` — the agent shut down with the prompt still queued;
    none of it ran.
  - `agent <name> stopped during prompt <id>`, `agent <name> failed during prompt <id>: <reason>`
    or `agent <name> stopped or crashed before prompt <id> finished` — the run was cut short,
    possibly after doing part of the work. Check the logs and its artifacts before sending it
    again (`send` wakes the agent).
  - `agent <name> is not responding` — see Recovery.
  - `unknown prompt id: <id>` — check the name and the id.

## States and waking

- `idle`, `running` or `compacting` while the runner answers; otherwise `stopped` after a stop,
  or `failed` after a crash or fatal error. `not-responding` means the runner did not answer in
  time: whether it is alive is unknown.
- `pi-dock ls` lists the agents and their states. `pi-dock show <name>` prints one agent's state,
  stored configuration and exact session file; there `-` means unset, tools `none` means
  `--no-tools`, and the system prompt appears only as its size. Neither wakes the agent.
- Agents are resident: a runner never exits because work finished, only on stop or a crash.
- `start`, `send` and `compact` wake a stopped or failed agent with its memory intact. `start`
  prints `<name> <state> <provider/id>`; on an agent that is already on it just prints that.
- If the agent stops or crashes mid-request, `start`, `send` and `compact` report
  `agent <name> stopped or crashed during <cmd>` instead of waking or retrying.
- `pi-dock stop <name>...` checks the whole list first: an invalid, unknown or repeated name
  fails and stops nothing. Then it stops the agents one after another and prints one line per
  name: `<name> stopped` only once its runner process has exited, or `<name> already stopped` /
  `<name> already failed`. A failure on one (e.g. not responding, or `did not exit within 5s`;
  see Recovery) is printed on stderr, the others are still stopped, and the exit code is 1.
  There is no `--all` and no pattern: list the names you mean.

## Changing an agent

- `pi-dock set <name> [--model <provider/id>] [--thinking <level>] [--system-prompt <file>]
  [--tools <a,b> | --no-tools] [--x key[=value]]...` works only on a stopped or failed agent
  (`agent <name> is running — stop it first` otherwise). The model is preflighted like
  spawn's. Each option replaces its stored value, and `--x` replaces the entire flag list; an
  option left out keeps it. There is no option to unset thinking, system prompt or tools, or to
  clear the whole flag list. The next wake applies the change; name, session, cwd and creation
  time never change.
- Serialize changes per agent: a successful `stop`, then `set`, then `start`. Do not overlap
  `set` with another `set`, or with `start`, `send` or `compact`, on the same agent.
- `--x key[=value]` flags are passed opaquely to extensions and are inert without them. A flag
  no loaded extension defines, or a value flag without its value, is not applied and is logged
  as a `diagnostic` event.
- `pi-dock compact <name> [instructions]` compacts the session. It requires an idle agent with
  no queued prompts and no compaction in progress, including one an extension started (`agent
  <name> is busy` otherwise). It wakes an off agent and leaves it on, and waits without a
  timeout; Ctrl-C only stops waiting, not the compaction. A failed compaction exits 1 with its
  reason.

## Role and tools

- `--system-prompt <file>` replaces Pi's base prompt (as `pi --system-prompt` does, and over
  `.pi/SYSTEM.md` in the agent's cwd); `APPEND_SYSTEM.md`, `AGENTS.md` context and the cwd
  still apply. Skills are listed only when the agent's tools include `read` or `bash`.
- The file must be readable and not blank; its path is relative to your cwd. The agent stores
  the content, not the path: editing or deleting the file later does not affect it. To change
  the prompt: `stop`, `set --system-prompt <file>`, `start`.
- `--tools a,b` is the exact list of tools the agent gets, built-in or from extensions; it
  replaces Pi's defaults (read, bash, edit, write), so name every tool it needs. No `*`,
  `+name` or `-name`. `--no-tools` gives none. The list applies on every wake.
- A name that no loaded tool has (a typo, or an extension that is not installed) fails
  startup with `tools not found: <names>` in the log: a spawn then creates no agent, and since
  `set` checks only the syntax, the next wake after a `set` fails the same way.
- Not a sandbox: extensions stay loaded even when their tools are not listed. pi-link stays
  connected without its tools, so add `link_send` (and the other `link_*` tools it needs) to
  `--tools` if the agent must reply over the link. pi-dock never adds tools on its own.
- pi-dock does not load Pi's built-in MCP and codemode extensions. Without an `mcp__` entry, MCP
  tools that extensions provide may remain callable through other tools; including any `mcp__`
  name filters MCP tools to the listed ones, and `--no-tools` removes them all.

## Reading logs

`pi-dock logs <name>` prints each event as `<ts> <event> [key=value]...`, with assistant text
below it. `--tail <n>` prints only the last n events, `--raw` the stored NDJSON lines (each with
`ts`), and `--follow` keeps printing new events until interrupted.

```
spawned pid                    the runner booted
queued id / run id             a prompt was accepted / its run started
turn id? / text id? text       a model turn started / assistant text of a finished turn
done id                        the run finished
run_failed id reason           the run ended in an unrecovered error or abort; agent stays on
dropped ids                    queued prompts that never ran, just before stopped/failed
stopped id? / failed id? reason
                               terminal; id is the run they interrupted
compacted / compact_failed reason / compact_cancelled   (all id?)
                               a compaction ended, whoever started it; it never ends the run
external id? type              a custom extension message of this type entered the context
                               (pi-link: link)
extension_error extension on reason
                               an extension handler for event `on` threw, or (on load) the
                               extension failed to load and the agent runs without it
diagnostic type message        at boot, a problem Pi reported while loading, e.g. an unknown
                               --x flag, or an extension package it could not install (the
                               agent runs without it)
```

- `done` proves that run ended, not that the agent is idle or a collaboration is over: queued
  prompts or extension callbacks (e.g. pi-link replies) can start later work. A team's
  conclusion is an application signal, such as an agreed final marker in a `text` event, and
  the artifact must still be verified. Never treat `done` or idle as "the team finished".
- `extension_error` and `diagnostic` do not by themselves change the state; a diagnostic may
  explain a later `failed`.
- An `id` ties an event to the run it happened in, not to its sender or cause; work that
  extensions start while the agent is idle has none. `external` means only that a message
  entered the context, not that the model acted on it, and its absence proves nothing; the
  message itself is in the session file.

## Recovery

- `agent <name> is not responding`: find the latest `{event:"spawned",pid}` in
  `pi-dock logs <name>`, check that PID's command line contains `runner.mjs --name <name>`
  (PIDs are reused), terminate it externally, then run `pi-dock start <name>`. Do not retry in
  a loop.
- `agent <name> did not exit within 5s; terminate PID <pid> externally`: check that PID's
  command line contains `runner.mjs --name <name>` (PIDs are reused), terminate it, and confirm
  that process has exited before starting the agent again or deleting its files: `pi-dock ls`
  can show `failed`, and `pi-dock stop` can print `already stopped`/`already failed`, while that
  process is still shutting down.
- `handshake failed for <name>`: a spawned or woken runner exited with an error, or did not
  answer status within 20 s.
  Read the printed manifest and log diagnostics and the `last log` line, if present. A
  `lock: <path> exists` line (Unix) means a runner is acquiring the socket, or one was killed
  while it did or could not remove it; the agent cannot start until it is removed. Remove that
  directory only after no process whose command line contains `runner.mjs --name <name>` is
  left.

## Data

- `~/.pi/dock/<name>.json` is the manifest and `~/.pi/dock/<name>.log` the event log. The
  session is the file `show` prints; do not build its path yourself.
- Never let Pi and a running agent write the same session, including through `pi -p`:
  `pi --session <file>` continues the agent's own session, and `--continue` or `--resume` in the
  agent's cwd may select it, so verify the selection or stop the agent first. What Pi adds there
  is part of the agent's memory on its next wake. To inspect the session, read the file.
  `pi --fork <file>` starts a separate session but can end an incomplete last line of the file
  with a newline: with a running agent, fork a copy of the file or use `pi-dock spawn --fork`,
  which only reads it. See
  [Opening an agent's session](../../README.md#opening-an-agents-session-in-pi).
- `stop` is not deletion, and pi-dock never deletes an agent or its files. Delete an agent only
  when the task asks for it, and only once the agent is off: `stop` printed `stopped`,
  `already stopped` or `already failed` (after a `did not exit` timeout, only once its runner
  process has exited; see Recovery). Without its manifest, a runner still on can no longer be
  stopped by name. Remove the manifest and the log (a new agent of that name would append to
  the old log), and the session file if wanted. See
  [Deleting an agent](../../README.md#deleting-an-agent).
