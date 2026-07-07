# PLAN — pi-dock v1 (lifecycle-only)

> **Status:** Ratified plan — execute top to bottom.
> **Base:** PROPOSAL.md (scope ratified 2026-07-02).
> **PIVOT 2026-07-06 (ratified):** agents are **resident**, not disposable. A runner
> stays alive until `stop`, crash, or budget — it never exits because work finished.
> `stop` = power off (files + memory kept; waking resumes the session with memory).
> Disposable exit-on-done was M0–M2's model; M3 refactors it away. Decisions #3/#5
> amended, #8–#10 added below.
> **Style contract:** simple, performant, readable, idiomatic; every line justified; abstractions only when essential. Plain ESM `.mjs`, **no build step**, no runtime deps beyond the Pi SDK.

---

## Decisions (agreed, do not relitigate)

| #   | Decision                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Plain `.mjs` (ESM), zero build. `node:util.parseArgs`, `node:net`, `node:fs` — no other deps besides `@earendil-works/pi-coding-agent`.                                                                                                                                                      |
| 2   | Data dir: `~/.pi/dock/` → `<name>.json` (manifest) + `<name>.log` (event log).                                                                                                                                                                                                               |
| 3   | **Status is derived, never stored.** Pipe alive → ask runner (`running`/`idle`). Pipe dead → last complete log line: `failed`/`stopped` is the state; anything else (incl. `idle`) = runner died without saying goodbye = `failed` (crash). A torn last line is ignored. *(Amended: `done` no longer exists — run completion logs non-terminal `idle`.)* |
| 4   | Manifest is **immutable after spawn** — identity + config only (`name`, `sessionFile`, `cwd`, `modelId`, `budget`, `pipe`, `startedAt`). Written atomically (tmp + rename) by the runner. Never rewritten.                                                                                   |
| 5   | Budget enforced **inside the runner**, **per prompt-run**: turn ceiling + wall-clock ceiling start with each run and reset when the runner returns to idle; breach → `session.abort()` + log `failed:budget` + exit. Budget bounds runaway runs, never punishes longevity.                                                                                                                                |
| 6   | `spawn` and `send` are distinct verbs — a typo can never silently create an agent.                                                                                                                                                                                                           |
| 7   | No daemon. One runner process per agent, `detached: true, stdio: 'ignore', windowsHide: true`.                                                                                                                                                                                               |
| 8   | **Resident lifecycle.** The runner never exits on its own: after each run it logs `{event:"idle"}` and waits. Exits only on `stop` (→ `stopped`), crash, or budget (→ `failed`). `stop` is power-off, not deletion — manifest/log/session survive; `send`/`start` wake a stopped or failed agent via `SessionManager.open(sessionFile)`, memory intact.                       |
| 9   | **`spawn` takes no initial text** — it creates identity only (name, model, budget, extension flags, cwd) and leaves the agent idle. All work flows through `send`. One way to do things.                                                                                                     |
| 10  | **`start <name>`** wakes a stopped/failed agent without sending work (symmetric with `stop`; needed for link presence without a prompt). Error if the name doesn't exist; success no-op if already running.                                                                                   |

## Architecture (target)

```
bin/pi-dock.mjs      CLI entry: parseArgs + dispatch to the 5 commands. Stateless.
src/runner.mjs       Detached process entry: hosts ONE AgentSession, serves pipe,
                     appends log, enforces budget, writes manifest, exits clean.
src/pipe.mjs         NDJSON over node:net — serve(path, handler) + request(path, msg).
src/manifest.mjs     Read/write <name>.json atomically; list all manifests.
src/paths.mjs        ~/.pi/dock resolution + pipe name per platform
                     (win: \\.\pipe\pi-dock-<name>, unix: ~/.pi/dock/<name>.sock).
```

Pipe protocol — 3 requests, one JSON per line:

```
→ {cmd:"status"}                ← {ok:true, state:"running"|"idle", turns:n}
→ {cmd:"prompt", text:"..."}    ← {ok:true}            (ack; run continues detached)
→ {cmd:"stop"}                  ← {ok:true}            (runner aborts, logs, exits)
```

Log events (append-only NDJSON, one fact per line):

```
{ts, event:"spawned"}
{ts, event:"turn", n}
{ts, event:"text", text}        (assistant output, for `logs`)
{ts, event:"idle"}              (non-terminal: run complete, runner waiting)
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

## Milestones

### M0 — Walking skeleton (THE risk; no SDK)

Fake runner: detach + manifest + pipe + heartbeat log, no AgentSession.
Proves on real Windows: runner survives parent shell death; pipe reconnects.

1. `src/paths.mjs`, `src/manifest.mjs`, `src/pipe.mjs`.
2. `src/runner.mjs` (fake mode: log a heartbeat every 2s, answer status/stop).
3. `bin/pi-dock.mjs` with all 5 commands wired to the fake runner.
4. **Gate:** `spawn --name w "x"` → close that shell → new shell: `ls` shows `w`
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
unknown flags degrade to diagnostics (no crash). Headless UI is safe: extensions get
`noOpUIContext`, so TUI calls like `ctx.ui.notify()` are no-ops.

Design: pi-dock stays extension-agnostic — generic pass-through, zero pi-link
dependency. pi-link absent → flags are inert, agent runs normally.

1. Spike (throwaway, no commit): spawn a runner with `extensionFlagValues`
   {link:true, link-name:<name>} → verify it appears in `link_list`, answers
   `link_prompt`, survives link traffic headless; document rough edges (fix
   candidates belong to pi-link, not pi-dock).
2. Runner: migrate createAgentSession → services path; accept repeatable
   `--x key[=value]` argv; manifest gains `flags` (written once at create —
   still immutable); wake re-applies flags from manifest so a woken agent
   rejoins the link with the same identity.
3. CLI: `spawn --x key[=value]` (repeatable, opaque) passed through to the
   runner. (No lifecycle work here — residency is M3; a linked agent is simply
   present on the link for its whole powered-on life.)
4. Smoke additions (LLM-free): unknown `--x bogus-flag=1` → agent spawns/stops
   normally.
5. **Gate:** full smoke; manual — spawn `--x link --x link-name=w`, see it in
   `link_list` from another terminal, `link_prompt` it, `pi-dock stop` removes
   it from the link, `start` puts it back.

### M5 — Ship

1. End-to-end pass on Windows (primary) — spawn/send/ls/logs/stop happy + crash paths.
2. Real README (replace placeholder), CHANGELOG.
3. Copy to `C:/AERO/me/code/pi-dock` (publish repo) → `npm publish` 0.1.0.

## Explicitly out of scope (v1.1+)

`reset-to-zero`, `compact`, `fork`, `set-model`, `rm` (delete = manual file removal
for now), any dashboard. (pi-link integration moved into scope — 2026-07-06.)
