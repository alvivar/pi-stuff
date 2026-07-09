# PLAN — pi-dock v1 (lifecycle-only)

> **Status:** Ratified plan — execute top to bottom.
> **Base:** PROPOSAL.md (scope ratified 2026-07-02).
> **PIVOT 2026-07-06 (ratified):** agents are **resident**, not disposable. A runner
> stays alive until `stop`, crash, or budget — it never exits because work finished.
> `stop` = power off (files + memory kept; waking resumes the session with memory).
> Disposable exit-on-done was M0–M2's model; M3 refactors it away. Decisions #3/#5
> amended, #8–#10 added below.
> **AMENDMENT 2026-07-08 (ratified):** agent control — `set` (edit powered-off
> identity: model/thinking/flags), `spawn --thinking`, `compact`. Decision #4
> amended, #11–#13 added, milestone M4.5 inserted. `restart` was considered and
> REJECTED — `stop` + `start` compose; sugar that can't help the wedged case.
> **AMENDMENT 2026-07-09 (ratified):** ship completeness — `rm` (decision #14),
> agent-oriented `--help` (decision #15), `set --budget` + explicit `--budget off`
> (decision #5/#11 amended). Folded into M5 below.
> **Style contract:** simple, performant, readable, idiomatic; every line justified; abstractions only when essential. Plain ESM `.mjs`, **no build step**, no runtime deps beyond the Pi SDK.

---

## Decisions (agreed, do not relitigate)

| #   | Decision                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Plain `.mjs` (ESM), zero build. `node:util.parseArgs`, `node:net`, `node:fs` — no other deps besides `@earendil-works/pi-coding-agent`.                                                                                                                                                      |
| 2   | Data dir: `~/.pi/dock/` → `<name>.json` (manifest) + `<name>.log` (event log).                                                                                                                                                                                                               |
| 3   | **Status is derived, never stored.** Pipe alive → ask runner (`running`/`idle`). Pipe dead → last complete log line: `failed`/`stopped` is the state; anything else (incl. `idle`) = runner died without saying goodbye = `failed` (crash). A torn last line is ignored. *(Amended: `done` no longer exists — run completion logs non-terminal `idle`.)* |
| 4   | Manifest holds identity + config only (`name`, `sessionFile`, `cwd`, `modelId`, `model`, `budget`, `flags`, `pipe`, `startedAt`), written atomically (tmp + rename). *(Amended 2026-07-08:)* the **runner** still never mutates it; the only writer after spawn is the CLI `set` command, which requires the agent powered off and rewrites atomically. Nothing changes while a runner is alive.                                                                                   |
| 5   | Budget enforced **inside the runner**, **per pipe prompt-run**: turn ceiling + wall-clock ceiling start with each pipe-delivered run and reset when the runner returns to idle; breach → `session.abort()` + log `failed:budget` + exit. Extension-originated work while idle is logged but unbudgeted; extension work steered into an active pipe run extends that run and counts toward its budget. Budget bounds total run size, never punishes longevity. *(Amended 2026-07-09:)* default stays `20,30` — the careless case must be the safe case; `--budget off` (spawn and set) disables both ceilings explicitly — unlimited is opt-in, never default; manifest stores `"off"` verbatim.                                                                                                                                |
| 6   | `spawn` and `send` are distinct verbs — a typo can never silently create an agent.                                                                                                                                                                                                           |
| 7   | No daemon. One runner process per agent, `detached: true, stdio: 'ignore', windowsHide: true`.                                                                                                                                                                                               |
| 8   | **Resident lifecycle.** The runner never exits on its own: after each run it logs `{event:"idle"}` and waits. Exits only on `stop` (→ `stopped`), crash, or budget (→ `failed`). `stop` is power-off, not deletion — manifest/log/session survive; `send`/`start` wake a stopped or failed agent via `SessionManager.open(sessionFile)`, memory intact.                       |
| 9   | **`spawn` takes no initial text** — it creates identity only (name, model, budget, extension flags, cwd) and leaves the agent idle. All work flows through `send`. One way to do things.                                                                                                     |
| 10  | **`start <name>`** wakes a stopped/failed agent without sending work (symmetric with `stop`; needed for link presence without a prompt). Error if the name doesn't exist; success no-op if already running.                                                                                   |
| 11  | **`set <name> [--model <provider/id>] [--thinking <level>] [--x key[=value]]...`** — controlled identity edit. Requires derived state `stopped`/`failed` (alive → error `agent <name> is running — stop it first`; missing → `no such agent`). `--model` re-runs the same preflight as spawn and writes a dedicated qualified `model` ref; the runner re-resolves that ref on every wake, so a qualified-model agent can fail honestly (`failed: model not found...`) if the model leaves the registry; recovery is `set --model <provider/id>`. Legacy manifests without `model` resume via the session file and never resolve ambiguous `modelId`. `--x` REPLACES the whole flags list (repeatable; no merge semantics — what you type is what you get); at least one option required. Hard identity (`name`, `sessionFile`, `cwd`, `pipe`, `startedAt`) untouchable. Atomic rewrite; next wake picks it up. *(Amended 2026-07-09:)* `--budget <turns>[,<min>]|off` joins the mutable set — budget is config, not identity (its original placement on the untouchable side was drafting oversight, not design); same validation as spawn; canonical recovery: `failed: budget` → `set <name> --budget …` → `start`. |
| 12  | **`spawn --thinking <level>`** — persisted in the manifest (`thinking`), applied to the session by the runner on every boot. Absent → model default, field omitted. Levels validated at spawn/set against what the SDK accepts; valid-but-unsupported levels are stored as requested and the SDK clamps per current model (spike M4.5-T1 pins the API). |
| 13  | **`compact <name> [instructions]`** — resident-agent maintenance. Pipe gains a 4th request `{cmd:"compact", instructions?}`; runner refuses unless idle (`{ok:false,error:"busy"}` → CLI prints `agent <name> is busy`). Off → wake, compact, stays on (same semantics as `send`). Logs `{event:"compacted"}`. Costs one real LLM summarization; **unbudgeted** — maintenance, not a run (consistent with #5). Compact is refused while a run is active; prompts acked during a compact queue behind it via the existing promise chain. |
| 14  | **`rm <name>`** — deletes the dock REGISTRY (`<name>.json` + `<name>.log`), not the memory: the session file is a standard Pi session owned by the user and is never touched (resumable from the normal Pi TUI; a future `--purge` could delete it explicitly — v1.1). Requires powered-off, same guard and error strings as `set` (`no such agent` / `agent <name> is running — stop it first`). Prints the orphaned session path on success so the memory is never silently lost. |
| 15  | **Agent-oriented `--help`** — `pi-dock --help` (and bare `pi-dock`) is written for an AI agent discovering the tool cold, not as syntax reminder: the resident mental model (spawn creates, never takes work; send delivers, never creates; stop = power off with memory kept), where replies appear (`logs <name>`, `{event:"text"}` lines, `--follow` streams), the derived states and what each implies, and the exact error strings with their remedy (`not responding` → kill the pid then `start` — never retry-loop). Static text, exit 0, smoke-asserted (LLM-free). |

## Architecture (target)

```
bin/pi-dock.mjs      CLI entry: parseArgs + dispatch to the 9 commands. Stateless.
src/runner.mjs       Detached process entry: hosts ONE AgentSession, serves pipe,
                     appends log, enforces budget, writes manifest, exits clean.
src/pipe.mjs         NDJSON over node:net — serve(path, handler) + request(path, msg).
src/manifest.mjs     Read/write <name>.json atomically; list all manifests.
src/paths.mjs        ~/.pi/dock resolution + pipe name per platform
                     (win: \\.\pipe\pi-dock-<name>, unix: ~/.pi/dock/<name>.sock).
```

Pipe protocol — 4 requests, one JSON per line:

```
→ {cmd:"status"}                 ← {ok:true, state:"running"|"idle", turns:n}
→ {cmd:"prompt", text:"..."}     ← {ok:true}           (ack; run continues detached)
→ {cmd:"compact", instructions?} ← {ok:true} | {ok:false,error:"busy"}   (M4.5)
→ {cmd:"stop"}                   ← {ok:true}           (runner aborts, logs, exits)
```

Log events (append-only NDJSON, one fact per line):

```
{ts, event:"spawned"}
{ts, event:"turn", n}
{ts, event:"text", text}        (assistant output, for `logs`)
{ts, event:"idle"}              (non-terminal: run complete, runner waiting)
{ts, event:"compacted"}         (non-terminal: context compaction done — M4.5)
{ts, event:"dropped", n}        (non-terminal: n acked-but-queued prompts lost
                                 to a stop/budget shutdown — logged just before
                                 the terminal event; review finding M3 T1)
{ts, event:"failed", reason} | {ts, event:"stopped"}     (terminal)
```

## Command flows

- **spawn** — error if manifest exists → pre-flight auth (model resolves + credentials) →
  launch detached runner → wait for pipe handshake → print name, exit. No initial text.
- **send** — error if manifest missing → pipe alive ? deliver prompt : wake runner
  with `SessionManager.open(sessionFile)`, then deliver. Agent stays on afterward.
- **start** — error if manifest missing → pipe alive ? report already running : wake
  runner (no prompt), wait for handshake, print state.
- **stop** — send `{cmd:"stop"}`; if pipe dead, report the derived off state (exit 0).
- **ls** — for each manifest: probe pipe → derive state (decision #3) → table:
  name, state, turns, elapsed, session file. States: `idle`/`running`/`stopped`/`failed`.
- **logs** — print `<name>.log` human-readably; `--follow` = poll/watch appended lines.
  Never touches the runner.
- **set** — error if manifest missing → error if pipe alive (`stop it first`) → validate
  options (model preflight; thinking level; flags replace) → atomic manifest rewrite →
  print new identity. Never launches a runner.
- **compact** — error if manifest missing → pipe alive ? send `{cmd:"compact"}` (busy →
  error) : wake runner, then compact. Agent stays on. Prints when the runner acks.
- **rm** — error if manifest missing → error if pipe alive (`stop it first`) → delete
  `<name>.json` + `<name>.log` → print the orphaned session path. Never touches the
  session file. Never launches a runner.

## Milestones

### M0 — Walking skeleton (THE risk; no SDK)

Fake runner: detach + manifest + pipe + heartbeat log, no AgentSession.
Proves on real Windows: runner survives parent shell death; pipe reconnects.

1. `src/paths.mjs`, `src/manifest.mjs`, `src/pipe.mjs`.
2. `src/runner.mjs` (fake mode: log a heartbeat every 2s, answer status/stop).
3. `bin/pi-dock.mjs` with all 5 commands wired to the fake runner.
4. **Gate (historical M0 syntax; spawn no longer takes text):** `spawn --name w "x"` → close that shell → new shell: `ls` shows `w`
   running → `logs w --follow` streams heartbeats → `stop w` → `ls` shows stopped.
   ALSO: kill -9 the runner → `ls` shows `failed`.

**Do not proceed past M0 until the gate passes on Windows.**

### M1 — Real SDK

1. Replace fake loop: `createAgentSession` (`hasUI:false` headless), `SessionManager.create(cwd)`
   on spawn / `SessionManager.open(sessionFile)` on resume.
2. Subscribe events → log `turn` / `text` / terminal events.
3. Budget: `--budget <turns>[,<minutes>]` (default conservative, e.g. 20 turns / 30 min).
4. `send` = resume-if-dead + prompt.
5. **Gate:** spawn a real task, close shell, `logs --follow` shows the agent working,
   `send` continues a finished agent, budget abort produces `failed:budget`.

### M2 — Robustness

1. Pre-flight auth at spawn (fail before detaching, clear message).
2. Torn-JSONL tolerance: verify session loader survives a killed-mid-append session file
   (proposal risk #2); if not, guard resume with a repair/trim step.
3. Error paths: unknown name, name collision, pipe timeout, stale socket file cleanup (unix).
4. Sweep: every line justified; remove anything speculative.

### M3 — Resident lifecycle refactor (the pivot)

Flip the runner from disposable to resident (decisions #8–#10). The wake machinery
(exactly-once delivery, resume-with-memory) already exists from M1 `send` — it becomes
the core; exit-on-done and its finish() scheduling are deleted.

1. Runner: remove exit-on-done; log non-terminal `{event:"idle"}` after each run
   settles; budget counters/timer reset on idle (per-run, decision #5 amended);
   terminal events reduce to `stopped`/`failed`.
2. CLI: `spawn` loses positional text (creates idle resident); `send` wakes
   stopped/failed agents and leaves them on; new `start` command (decision #10);
   `ls` drops `done` (derivation per amended decision #3).
3. test/smoke.mjs: rewrite for resident flow — spawn idle → send twice (memory
   across runs, agent stays on) → stop → send wakes → stop; kill -9 → `failed` →
   `start` revives; budget breach → `failed:budget` → wake works. Keep the 2-real-
   prompt cost ceiling.
4. **Gate:** full smoke + manual Windows pass of the new surface.

### M4 — Extension flags (pi-link connectivity)

Mechanism (verified against SDK 0.80.3 source): extensions installed as Pi packages
(e.g. pi-link) already load in runner sessions via DefaultResourceLoader but stay
dormant; activation reads extension-registry flags (`pi.getFlag("link")`), NOT
process.argv. The SDK exposes `createAgentSessionServices({ cwd, authStorage,
modelRegistry, extensionFlagValues: Map })` + `createAgentSessionFromServices(...)`;
unknown flags degrade to diagnostics (no crash). Detached runners bind extensions
with an inert headless UI context; the SDK default no-op UI can touch uninitialized
TUI theme state, so pi-dock owns the headless UI boundary explicitly.

Design: pi-dock stays extension-agnostic — generic pass-through, zero pi-link
dependency. pi-link absent → flags are inert, agent runs normally.

1. [x] Spike (throwaway, no commit): spawn a runner with `extensionFlagValues`
   {link:true, link-name:<name>} → verify it appears in `link_list`, answers
   `link_prompt`, survives link traffic headless; document rough edges (fix
   candidates belong to pi-link, not pi-dock).
2. [x] Runner: migrate createAgentSession → services path; accept repeatable
   `--x key[=value]` argv; manifest gains `flags` (written once at create —
   still immutable); wake re-applies flags from manifest so a woken agent
   rejoins the link with the same identity. Budget still bounds only pipe-
   delivered runs; extension-originated runs are visible in logs but unbudgeted.
3. [x] CLI: `spawn --x key[=value]` (repeatable, opaque) passed through to the
   runner. (No lifecycle work here — residency is M3; a linked agent is simply
   present on the link for its whole powered-on life.)
4. [x] Smoke additions (LLM-free): unknown `--x bogus-flag=1` → agent spawns/stops
   normally.
5. [x] **Gate:** full smoke; manual — spawn `--x link --x link-name=w`, see it in
   `link_list` from another terminal, `link_prompt` it, `pi-dock stop` removes
   it from the link, `start` puts it back.

### M4.5 — Agent control (`set`, `--thinking`, `compact`)

Ratified 2026-07-08 from real usage: agents created without link flags need them
later; long-lived residents need model/effort changes and context maintenance.
`restart` rejected (see header note).

1. [x] Spike (throwaway, no commit): pin the SDK 0.80.3 APIs — (a) how to compact a
   headless AgentSession (method name, does it need instructions, what happens
   to the session file: rewrite vs marker-append; effect on a later resume);
   (b) how to set thinking/reasoning level on a session at create/open (exact
   option name, accepted values, per-model validity). Budget: ≤2 real LLM
   operations (1 tiny prompt to give the scratch session content + 1
   compaction). Findings shape task 2's brief.
2. [x] Implementation: runner applies `thinking` from manifest on boot + serves
   `{cmd:"compact"}` (idle-only, logs `compacted`, unbudgeted); CLI gains `set`
   (decision #11) and `compact` (decision #13); `spawn --thinking` (decision
   #12); usage lines updated; smoke additions, LLM-free only: `set` on
   missing/alive agent errors, `set` rewrites manifest fields + preserves hard
   identity, `compact` on missing agent errors. Compaction correctness was the
   spike's job — smoke checks plumbing and error paths, not summarization.
3. **Gate:** full smoke; manual — `set` a stopped agent's model + flags → `start`
   → wakes with the new model and joins the link with the new flags; `compact`
   an idle agent with memory → summary survives, agent still answers.

### M5 — Ship (amended 2026-07-09)

1. Ship completeness (code): `rm` (decision #14); agent-oriented `--help` +
   bare `pi-dock` (decision #15); `set --budget` and `--budget off` at spawn
   and set (decisions #5/#11 amended); sweep the two accepted M4.5 minors
   (inert wake `--model` argv — trim or justify; compact-vs-stop print
   cosmetic — fix only if free). Smoke additions, LLM-free: rm
   missing/alive/stopped (+ session file survives), --help exits 0 and
   contains the model/states/errors sections, set --budget rewrites, budget
   "off" accepted at spawn and set, existing ceiling intact.
2. End-to-end pass on Windows (primary) — all 9 commands
   (spawn/send/start/stop/set/compact/rm/ls/logs), happy + crash + wedged paths.
3. Real README (replace placeholder) + CHANGELOG. Honesty requirements:
   (a) where replies appear — send acks and detaches, output lives in
   `logs --follow`; (b) failure taxonomy — derived `failed`, budget breach,
   wedged runner and its manual-kill remedy; (c) unix branch verified by
   inspection, smoke ran on Windows only; (d) the resident model — stop is
   power-off, memory persists, session resumable from the normal Pi TUI.
4. Copy tested workshop → `C:/AERO/me/code/pi-dock` (publish repo), version
   0.1.0, package style consistent with pi-link (author alvivar, MIT,
   `pi-package` keyword) → USER runs `npm login` + `npm publish`.

## Explicitly out of scope (v1.1+)

`reset-to-zero`, `fork`, `rm --purge` (deleting the session file), `info` /
identity columns in `ls` (model/thinking/flags visible without opening the
JSON), `send -` (stdin for long prompts — argv length/quoting limits on
Windows), any dashboard, `restart` (rejected — composition covers it).
(pi-link integration moved into scope 2026-07-06; `compact` and `set-model`
promoted into M4.5, generalized as `set` — 2026-07-08; `rm`, `--help`,
`set --budget`, `--budget off` promoted into M5 — 2026-07-09.)
