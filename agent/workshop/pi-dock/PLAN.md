# PLAN — pi-dock v1 (lifecycle-only)

> **Status:** Ratified plan — execute top to bottom.
> **Base:** PROPOSAL.md (scope ratified 2026-07-02).
> **Style contract:** simple, performant, readable, idiomatic; every line justified; abstractions only when essential. Plain ESM `.mjs`, **no build step**, no runtime deps beyond the Pi SDK.

---

## Decisions (agreed, do not relitigate)

| #   | Decision                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Plain `.mjs` (ESM), zero build. `node:util.parseArgs`, `node:net`, `node:fs` — no other deps besides `@earendil-works/pi-coding-agent`.                                                                                                                                                      |
| 2   | Data dir: `~/.pi/dock/` → `<name>.json` (manifest) + `<name>.log` (event log).                                                                                                                                                                                                               |
| 3   | **Status is derived, never stored.** Pipe alive → ask runner (`running`/`idle`). Pipe dead → last complete log line: `done`/`failed`/`stopped` is the state; anything else = runner died without saying goodbye = `failed` (crash). A torn last line is ignored (append-only is crash-safe). |
| 4   | Manifest is **immutable after spawn** — identity + config only (`name`, `sessionFile`, `cwd`, `modelId`, `budget`, `pipe`, `startedAt`). Written atomically (tmp + rename) by the runner. Never rewritten.                                                                                   |
| 5   | Budget enforced **inside the runner**: turn ceiling (count `turn_start`) + wall-clock ceiling (`setTimeout`); both → `session.abort()` + log `failed:budget`.                                                                                                                                |
| 6   | `spawn` and `send` are distinct verbs — a typo can never silently create an agent.                                                                                                                                                                                                           |
| 7   | No daemon. One runner process per agent, `detached: true, stdio: 'ignore', windowsHide: true`.                                                                                                                                                                                               |

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
{ts, event:"done"} | {event:"failed", reason} | {event:"stopped"}
```

## Command flows

- **spawn** — error if manifest exists → pre-flight auth (model resolves + credentials) →
  launch detached runner → wait for pipe handshake → print name, exit.
- **send** — error if manifest missing → pipe alive ? send prompt : relaunch runner
  with `SessionManager.open(sessionFile)`, then send prompt.
- **ls** — for each manifest: probe pipe → derive state (decision #3) → table:
  name, state, turns, elapsed, session file.
- **logs** — print `<name>.log` human-readably; `--follow` = poll/watch appended lines.
  Never touches the runner.
- **stop** — send `{cmd:"stop"}`; if pipe dead, report already-stopped state.

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

### M3 — Ship

1. End-to-end pass on Windows (primary) — spawn/send/ls/logs/stop happy + crash paths.
2. Real README (replace placeholder), CHANGELOG.
3. Copy to `C:/AERO/me/code/pi-dock` (publish repo) → `npm publish` 0.1.0.

## Explicitly out of scope (v1.1+)

`reset-to-zero`, `compact`, `fork`, `set-model`, pi-link integration, any dashboard.
