# pi-dock — design (as built)

**Identity:** pi-dock keeps named Pi agents running after your shell exits — create one,
give it work, come back later to read it, stop it, wake it with memory intact.

Authority comes from *owning the agent's session*. pi-link is horizontal messaging between
terminals; pi-dock is vertical ownership (create, persist, power). They are orthogonal and
compose through opaque extension flags.

**Style contract:** simple, performant, readable, idiomatic; every line justified;
abstractions only when essential. Plain ESM `.mjs`, no build step, no runtime deps beyond
`@earendil-works/pi-coding-agent`. When a design supersedes another, the old path is deleted
completely — no shims, no parallel implementations, no speculative compatibility.

## Contracts (do not relitigate without new evidence)

1. **No daemon.** One detached runner process per agent (`detached`, `stdio:'ignore'`,
   `windowsHide`) hosting one in-process `AgentSession`, plus a stateless CLI.
2. **Data dir** `~/.pi/dock/` → `<name>.json` (manifest) + `<name>.log` (event log).
   Pipe: Windows `\\.\pipe\pi-dock-<name>`, Unix `~/.pi/dock/<name>.sock`.
3. **Names** match `^[a-z0-9]+(?:[._-][a-z0-9]+)*$`, max 64, Windows reserved device
   basenames rejected case-insensitively. Rejected (never normalized) as
   `invalid agent name: <value>` before any path or pipe access, by every command.
4. **Status is derived, never stored.** Pipe answers → `running`/`idle`. Pipe dead → last
   *complete* log line: `stopped`/`failed` is the state; anything else = crash = `failed`.
   Only a torn final fragment is ignored.
5. **Manifest** = identity + config: `name`, `sessionFile`, `cwd`, `model` (qualified
   `provider/id`, mandatory, sole wake authority), `thinking?`, `budget`, `flags`, `pipe`,
   `startedAt`. Creation is exclusive winner-safe publication; rewrites are atomic. The
   runner never writes it after creation; the only later writer is `set` (powered off).
   A manifest without `model` refuses to wake:
   `manifest model missing: <name> — set --model <provider/id> to repair`.
6. **Resident lifecycle.** The runner never exits because work finished: after each run it
   logs `idle` and waits. It exits only on `stop` (→ `stopped`), crash, or budget
   (→ `failed`). `stop` is power-off: manifest, log and session survive; `send`/`start`/
   `compact` wake via `SessionManager.open(sessionFile)` with memory intact.
7. **`spawn` creates identity only** (no initial text) in the current cwd and leaves the
   agent idle. **`send` delivers, never creates.** A typo can never create an agent.
   Concurrent same-name spawns: exactly one succeeds (status PID must equal the launched
   child PID); losers print `agent already exists: <name>` and never touch the winner.
8. **Budget** is enforced inside the runner, **per pipe-delivered run**: turn ceiling +
   wall-clock ceiling, reset at idle; breach → `abort` + `failed: budget` + exit. Default
   `20,30`. Grammar: `<turns>` positive integer, optional `<minutes>` positive number
   ≤ 35791 (one value → 30 min); `off` = explicit unlimited, stored verbatim. Invalid →
   `invalid budget: <value>`. Extension-originated work while idle is unbudgeted; work
   steered into an active pipe run counts toward it.
9. **`set`** edits model / thinking / budget / flags only when the agent is confirmed
   powered off. Alive → `agent <name> is running — stop it first`; unresponsive →
   `agent <name> is not responding`; missing → `no such agent: <name>`. `--x` replaces the whole
   flag list. Hard identity (`name`, `sessionFile`, `cwd`, `pipe`, `startedAt`) is
   untouchable. Next wake applies it.
10. **`--thinking <level>`** persisted and applied every boot; absent → model default;
    unsupported levels are stored as requested and clamped by the SDK.
11. **`compact [instructions]`** is idle-only (`agent <name> is busy` otherwise), wakes an
    off agent and leaves it on, logs `compacted`, unbudgeted (maintenance, not a run).
12. **Extension flags** `--x key[=value]` are opaque pass-through
    (`extensionFlagValues`); pi-dock has zero pi-link knowledge. Unknown flags are inert.
    Runners bind extensions with an explicit inert headless UI context.
13. **No destructive command.** `rm` was rejected: registry-only deletion orphans the
    name→session/config mapping; deleting the session destroys memory. `restart` was
    rejected: `stop` + `start` compose, and sugar cannot help a wedged runner.
14. **Agent-oriented help.** Bare `pi-dock`, `--help`, `-h` print the same self-contained
    text to stdout, exit 0. Unknown command exits 1 pointing to `--help`. Wedged runner
    remedy: latest `{event:"spawned",pid}` in logs → kill that PID externally → `start`.

## Architecture

```
bin/pi-dock.mjs    CLI: parseArgs + dispatch to the 8 commands. Stateless.
src/runner.mjs     Detached entry: hosts one AgentSession, serves pipe, appends log,
                   enforces budget, publishes manifest on create.
src/pipe.mjs       NDJSON over node:net — serve(path, handler) + request(path, msg).
src/manifest.mjs   Exclusive create / atomic rewrite / list of <name>.json.
src/budget.mjs     Budget grammar + validation.
src/paths.mjs      Name validation, ~/.pi/dock resolution, per-platform pipe path.
```

Pipe protocol (one JSON per line):

```
→ {cmd:"status"}                 ← {ok:true, state:"running"|"idle", turns, pid}
→ {cmd:"prompt", text}           ← {ok:true}                 (ack; run continues detached)
→ {cmd:"compact", instructions?} ← {ok:true} | {ok:false, error:"busy"}
→ {cmd:"stop"}                   ← {ok:true}                 (runner aborts, logs, exits)
```

Log events (append-only NDJSON, one fact per line):

```
{ts, event:"spawned", pid}     every boot
{ts, event:"turn", n}
{ts, event:"text", text}       assistant output
{ts, event:"idle"}             run complete, waiting (non-terminal)
{ts, event:"compacted"}        (non-terminal)
{ts, event:"dropped", n}       acked-but-queued prompts lost to shutdown, just before terminal
{ts, event:"failed", reason} | {ts, event:"stopped"}   terminal
```

`logs --follow` reads the whole file as a Buffer each poll and commits a byte offset only
through the last complete newline (deliberately simple; not an append-only reader).

## Tests

- `node test/regression.mjs` — LLM-free, sandboxed (own HOME, SDK dirs, `PI_OFFLINE=1`).
  Run after every change.
- `node test/smoke.mjs` — full lifecycle, **2 real provider prompts**. Paid: run only on
  explicit owner authorization, no automatic retry.

## Verified

Windows: full lifecycle and E2E of all 8 commands. Unix: inspected, not runtime-tested.
Real usage: RV lab (2026-08-18) — 3 residents, ~145 piped prompts, ~50 min, zero tool
failures.
