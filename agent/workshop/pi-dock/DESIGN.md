# pi-dock — design (as built, 0.2.0)

**Identity:** pi-dock keeps named Pi agents running after your shell exits — create one,
give it work, wait for or read its result, stop it, wake it with memory intact.

Authority comes from *owning the agent's session*. pi-link is horizontal messaging between
terminals; pi-dock is vertical ownership (create, persist, power). They are orthogonal and
compose through opaque extension flags.

**Style contract:** simple, performant, readable, idiomatic; every line justified;
abstractions only when essential. Plain ESM `.mjs`, no build step, no runtime deps beyond
`@earendil-works/pi-coding-agent`. When a design supersedes another, the old path is deleted
completely — no shims, no parallel implementations, no speculative compatibility.

## Commands

12 commands: `spawn`, `start`, `stop`, `ls`, `show`, `logs`, `send`, `wait`, `set`,
`compact`, `models`, `skill`, plus `--help`/`-h`. Usage lines live in one `USAGE` map that also
generates the help's usage section.

## Contracts (do not relitigate without new evidence)

1. **No daemon.** One detached runner process per agent (`detached`, `stdio:'ignore'`,
   `windowsHide`) hosting one in-process `AgentSession`, plus a stateless CLI.
2. **Data.** `~/.pi/dock/<name>.json` (manifest) + `<name>.log` (event log). Pipe: Windows
   `\\.\pipe\pi-dock-<name>`, Unix `~/.pi/dock/<name>.sock` (stale sockets are probed and
   replaced). Sessions are created by `SessionManager.create(cwd)` in Pi's default session dir
   (`<agent dir>/sessions/--<cwd>--/`, agent dir `~/.pi/agent` or `PI_CODING_AGENT_DIR`);
   the manifest's `sessionFile` is the exact path.
3. **Names** match `^[a-z0-9]+(?:[._-][a-z0-9]+)*$`, max 64, Windows reserved device
   basenames rejected case-insensitively. Rejected (never normalized) as
   `invalid agent name: <value>` before any path or pipe access, by every command.
4. **State is derived, never stored.** Pipe answers → `idle` / `running` / `compacting`.
   Pipe dead → last *complete* log line: `stopped`/`failed` is the state; anything else =
   crash = `failed`. Only a torn final fragment is ignored. `ls` and `show` probe with a
   200 ms status request and never wake.
5. **Manifest** = identity + config: `name`, `sessionFile`, `cwd`, `model` (qualified
   `provider/id`, mandatory, sole wake authority), `thinking?`, `flags`, `pipe`,
   `startedAt`. Creation is exclusive winner-safe publication (temp file + `link`);
   rewrites are atomic (temp file + `rename`). The runner writes it only on create, which
   only `--create` (passed by `spawn`) requests; a wake without a manifest fails. The only
   later writer is `set` (powered off), which writes exactly these fields. A manifest
   without `model` refuses to wake:
   `manifest model missing: <name> — set --model <provider/id> to repair`.
6. **Resident lifecycle, no limits.** The runner never exits because work finished. It
   exits only on `stop` (→ `stopped`) or a crash/fatal error (→ `failed`). There is no
   turn, time or cost limit, and work extensions start while idle (e.g. pi-link messages)
   is unbounded too. Headless runners load `<cwd>/.pi` config and extensions without Pi's
   project-trust prompt.
7. **`spawn` creates identity only** (no initial text) in the current cwd and leaves the
   agent idle; **`send` delivers, never creates** — a typo can never create an agent.
   Spawn preflights first: `--model` must resolve (else `model X not found (did you mean: …;
   see: pi-dock models X)`) and have usable credentials; without `--model`, Pi's default
   model must have them. Failure: `preflight failed: <reason>; no agent was created`.
   Concurrent same-name spawns: exactly one succeeds (its status PID must equal the
   launched child PID); losers print `agent already exists: <name>` and never touch the
   winner. `spawn` and `start` print `<name> <state> <provider/id>` (live model).
8. **Wake rule.** `start` wakes unless status answers ok (`not responding` on timeout).
   `send` and `compact` deliver; only an absent pipe or a `terminal` reply wakes the agent
   (`SessionManager.open(sessionFile)`, memory intact), once, then redeliver. A pipe that
   closes mid-request is reported as `agent <name> stopped or crashed during <cmd>`, never
   woken or retried; a timeout is `agent <name> is not responding`. Wake waits up to 20 s
   for the handshake, else prints manifest/log diagnostics and exits 1.
9. **Prompt correlation.** The runner assigns each pipe prompt an id (`p` + 12 hex) and
   logs `queued {id}` synchronously before acking `{ok:true, id}`; `send` prints the id.
   Prompts run one at a time, each only after idle extension work has settled (until then
   it stays queued). A run logs `run {id}`, its `turn`/`text` events carry the id, and it
   ends with `done {id}` or — when its last turn ended with stopReason `error`/`aborted`
   (an auto-retry followed by success is `done`) — `run_failed {id, reason}`; the agent
   stays on. On shutdown, prompts still queued are logged as `dropped {ids}` and the
   terminal `stopped`/`failed` carries the id of the run it interrupted. Attribution is by
   run, not exclusive causality: work extensions steer into an active run (e.g. a pi-link
   message) shares that run's id; only work extensions start while idle logs `turn`/`text`
   without id. A run's final text is the `text {id}` after its last `turn {id}`, if any.
   `done` proves that run ended, not that the agent is idle; status is the authority.
10. **`wait <name> <id>`** decides from the log plus a status liveness poll (500 ms): `done`
    → exit 0 printing the final text (nothing if none); `run_failed`, `dropped`,
    `stopped`/`failed` with the id, an id absent from the log (`unknown prompt id`), or a
    `spawned` after the id (a new runner: the prompt was lost) → exit 1 with the reason.
    Pipe absent or closed → re-read the log once, else
    `agent <name> stopped or crashed before prompt <id> finished`; status timeout → not
    responding. Never wakes, never retries, no timeout; Ctrl-C only stops waiting.
    `send --wait` = send + wait, with the id on stderr (to re-attach) and only the final text
    on stdout. `send --file <path>` reads a UTF-8 prompt; `--` ends options; exactly one of
    text or `--file`, never empty.
11. **`stop` confirms exit.** The stop reply carries the runner PID; `stop` prints
    `<name> stopped` only once that process no longer exists (pid liveness, not pipe absence:
    the pipe closes before exit). Still alive after 5 s → `agent <name> did not exit within 5s;
    terminate PID <pid> externally`, no kill. An agent already off prints
    `<name> already stopped|failed`. `stop <name>...` takes explicit names only (no `--all`, no
    patterns: a wrong pattern on stop is expensive). The whole list is validated before acting
    (syntax, no repeats, every manifest exists), so a typo stops nothing. Then each agent is
    stopped in order, sequentially (a normal stop takes well under a second; only a misbehaving
    agent costs up to ~8 s, and output stays in argument order). An operational failure
    (not responding, did not exit, unexpected reply) goes to stderr and the rest still stop;
    exit 1 if any failed. No transaction, no rollback.
12. **`set`** edits model / thinking / flags only when the agent is confirmed powered off.
    Alive → `agent <name> is running — stop it first`; unresponsive →
    `agent <name> is not responding`; missing → `no such agent: <name>`. `--model` is
    preflighted (`…; no agent was changed`). `--x` replaces the whole flag list. Hard
    identity (`name`, `sessionFile`, `cwd`, `pipe`, `startedAt`) is untouchable. Next wake
    applies it.
13. **`--thinking <level>`** is `off|minimal|low|medium|high|xhigh|max`, persisted and
    applied every boot; absent → Pi restores the session's saved level or uses its
    configured default (per-model, then global); levels a model does not support are stored
    as requested and clamped by the SDK.
14. **`compact [instructions]`** is idle-only (`agent <name> is busy` otherwise, including
    queued prompts), wakes an off agent and leaves it on, and waits without a timeout for
    the runner's reply. It logs `compacted`, or `compact_failed {reason}` and exits 1 with
    the reason (e.g. `Nothing to compact (session too small)`).
15. **Extension flags** `--x key[=value]` are opaque pass-through
    (`extensionFlagValues`); pi-dock has zero pi-link knowledge. Unknown flags are inert.
    Runners bind extensions with an explicit inert headless UI context (`mode: 'print'`).
16. **No destructive command.** `rm` was rejected: registry-only deletion orphans the
    name→session/config mapping; deleting the session destroys memory. `restart` was
    rejected: `stop` + `start` compose, and sugar cannot help a wedged runner.
17. **Strict arguments.** Every command parses with strict `parseArgs`; unknown options and
    extra positionals fail with Node's first error sentence (or
    `Unexpected argument '<x>'`) plus `usage: <line>`, exit 1. `compact` alone joins its
    raw remaining arguments as instructions.
18. **Help for humans, skill for AIs.** Bare `pi-dock`, `--help`, `-h` print the same short
    help to stdout (usage, example, essentials, the trust and no-limits warnings in one line
    each), exit 0; extra arguments are a usage error. It ends telling AI agents to read
    `pi-dock skill` first. `skill` prints `skills/pi-dock/SKILL.md` byte for byte, read from
    the package path (single source). The skill is the AI operating contract: when to use
    pi-dock, workflow, prompt ids and wait outcomes, states and waking, set/compact, log
    events, recovery (wedged runner: latest `{event:"spawned",pid}` in logs → kill that PID
    externally → `start`), data paths, warnings. Unknown command exits 1 pointing to
    `--help`.
19. **Observation.** `logs` renders each event as `<ts> <event> key=value…` (strings
    verbatim, other values as JSON) with `text` indented two spaces below; unparsable lines
    print raw. `--raw` prints stored NDJSON, `--tail <n>` the last n events, `--follow`
    polls every 500 ms; all read only complete lines. `show` prints name, state, model,
    thinking, flags, cwd, session, created. `ls` columns: name, state, model, age (largest
    whole unit). `models [filter]` lists credentialed models (`model context max-out
    thinking images`); filter = case-insensitive substring of `provider/id`, or
    provider-part/id-part with a slash; no match → exit 1.
20. **Pi package.** `package.json` has the `pi-package` keyword and an explicit manifest
    `pi: {skills: ["./skills"]}`, so Pi loads only the skill and never treats `bin/` or
    `src/` as extensions. The SDK stays in `dependencies`: the runner is a separate Node
    process that imports it, and Pi's peer-dependency rule (and its warning) applies only to
    extension code loaded into Pi itself. No `files` field: the whole package ships.
21. **External messages.** The runner logs `external {id?, type}` whenever a custom message
    enters the session context, from two public session events: `message_start` with
    `role:"custom"` (type = `customType`; `sendMessage` while idle or steered, context-only
    appends, `nextTurn`, `before_agent_start` messages) and `entry_appended` of a
    `custom_message` entry (boundary drafts from `turn_end`/`agent_before_settle`, which
    never surface as `message_start`). `id` follows contract 9. Only the type is logged —
    no content, sender or details, so pi-dock needs no extension's schema. It records
    entry, not cause: a steered message can join a turn that tool calls already required.
    Not seen: extension prompts sent as user messages (`sendUserMessage`, indistinguishable
    from a pipe prompt) and messages queued but lost to stop/abort. `wait` ignores it.

## Architecture

```
bin/pi-dock.mjs    CLI: strict parseArgs + dispatch to the 12 commands. Stateless.
skills/pi-dock/    SKILL.md — AI operating guide; printed by `skill`, loaded by Pi.
src/runner.mjs     Detached entry: hosts one AgentSession, serves the pipe, queues and
                   correlates prompts, appends the log, publishes the manifest on create.
src/pipe.mjs       NDJSON over node:net — serve(path, handler) + request(path, msg, timeout).
src/manifest.mjs   Exclusive create / atomic rewrite / list of <name>.json.
src/paths.mjs      Name validation, ~/.pi/dock resolution, per-platform pipe path.
```

Pipe protocol (one JSON object per line; requests time out after 3 s unless noted):

```
→ {cmd:"status"}                 ← {ok:true, state:"idle"|"running"|"compacting", model, pid}
→ {cmd:"prompt", text}           ← {ok:true, id}            (ack; the run continues detached)
→ {cmd:"compact", instructions?} ← {ok:true} | {ok:false, error:"busy"|<reason>}
                                   (replies when compaction settles; no timeout)
→ {cmd:"stop"}                   ← {ok:true, pid}           (then aborts, logs, closes, exits)
any command while shutting down  ← {ok:false, error:"terminal"}   (status/prompt/compact)
unknown cmd                      ← {ok:false, error:"unknown"}
```

Log events (append-only NDJSON, one fact per line, each with `ts`):

```
{event:"spawned", pid}              every boot, once the pipe listens
{event:"queued", id}                prompt accepted (before the ack)
{event:"run", id}                   its run starts
{event:"turn", id?}                 turn start
{event:"text", id?, text}           assistant text of a finished turn (non-empty)
{event:"external", id?, type}       a custom message entered the context (non-terminal)
{event:"done", id}                  run complete (non-terminal)
{event:"run_failed", id, reason}    run ended in an unrecovered error/abort (non-terminal)
{event:"compacted"} | {event:"compact_failed", reason}                (non-terminal)
{event:"dropped", ids}              queued prompts lost to shutdown, just before terminal
{event:"stopped", id?} | {event:"failed", id?, reason}                terminal
```

`logs` and `wait` read the whole file as a Buffer each poll and commit a byte offset only
through the last complete newline (deliberately simple; not an append-only reader).

## Tests

- `node test/regression.mjs` — LLM-free, sandboxed (own HOME/USERPROFILE/APPDATA,
  `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`). Real runners talk to a local faux
  OpenAI-compatible SSE provider declared in the sandbox `models.json` (scripted replies,
  HTTP 500s, held replies), with sandbox retry settings and a sandbox extension that starts
  idle work. Covers names, manifests, spawn races, state derivation, strict args, logs,
  models, wake/deliver classification, correlation, wait, send `--wait`/`--file`/`--`,
  stop confirmation, compaction, help and `skill`. Run after every change.
- `node test/smoke.mjs` — full lifecycle against the real default model, **2 real
  prompts** via `send --wait`. Paid: run only on explicit owner authorization, no automatic
  retry.

## Verified

Windows: regression passes on every change; the paid smoke passed 50/50 at 2e6644f on 0.2.0
(2026-10-01, `openai-codex/gpt-6.1-sol`). Unix: inspected, not runtime-tested.
Real usage: RV lab (2026-08-18) — 3 residents, ~145 piped prompts, ~50 min, zero tool
failures.
