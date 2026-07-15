# PROPOSAL — Named detached Pi agents (MVP)

> **Status:** Proposal / exploration (revised after fable + gpt review)
> **Last aligned:** 2026-07-02
> **Build from this?** Yes — scope ratified by owner (2026-07-02): v1 = lifecycle-only; admin levers (reset-to-zero, compact, fork, set-model) deferred to v1.1.
> **Summary:** a tiny tool that keeps **named Pi agents alive after your shell exits**, and lets you start, continue, list, watch, and stop them. No daemon, no fleet dashboard — one small runner process per agent plus a stateless CLI. Separate product from pi-link.

---

## Identity (one sentence)

**`pi-dock` keeps named Pi agents running after your shell exits — start one, let it go, come back later to see it, give it more work, or stop it.**

Authority comes from _owning the agent's session_, not from reaching into anyone's terminal. That is the whole difference from pi-link (lateral messaging between human terminals). This is vertical: create, own, persist. (Doc language avoids "control plane" / "fleet manager" in v1 — the tool is smaller than those words.)

## Why this can't just be a script

`pi -p "<prompt>"` already runs one agent to completion and persists a session — so a thin wrapper adds nothing. The only things no script gives you, and the only things worth building:

1. **Ownership that outlives the shell** — the agent keeps running after the terminal that launched it closes.
2. **Named persistence** — come back by name to a stopped/idle agent and continue its work.
3. **A safety floor** — a budget so an unattended agent can't loop forever or run up an unbounded bill.

## Architecture — no daemon

The review's decisive finding: a resident daemon does not _solve_ the hard problem (detach + crash-safe registry), it _duplicates_ it. So there is no central process.

```
pi-dock <cmd>               stateless CLI. Reads the registry directory,
   │                        connects directly to a runner's pipe.
   │  (per-agent control pipe)
   ▼
runner  (one per agent)     a tiny process that hosts ONE AgentSession via the
                            SDK, serves one named pipe (Windows) / unix socket,
                            self-enforces its budget, appends its own log file,
                            and writes its own <name>.json manifest.
```

- **One OS process per agent.** This gives crash isolation _and_ per-agent kill/limits for free — while each runner uses the **in-process SDK** internally, so `prompt` / `compact` / `navigateTree` stay first-class with **no RPC gap and no upstream dependency**. (This dissolves the earlier in-process-vs-subprocess question: you get both.)
- **Registry = a directory of `<name>.json` manifests** (`{name, sessionFile, cwd, model, thinkingLevel, tools, budget, pipe, startedAt}`), one file per agent. Qualified mandatory `model` is the sole wake authority; no duplicate `modelId` or session-derived fallback. Targets are published with exclusive winner-safe semantics and later rewrites are atomic. No shared store and nothing to rehydrate.
- **Status is derived, never stored** — from pipe liveness + the session's own state. A stored status lies after a crash; deriving is both less code and always correct.
- **No new runtime dependency** beyond the SDK (Node `net` for the pipe, newline-delimited JSON).

## Commands (the whole surface — 5)

| Command                                                | Does                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn "<prompt>" --name <n> [--cwd --model --budget]` | Create a **new** agent (errors if the name exists — no silent duplicate on a typo), start the prompt, detach. Returns the name.        |
| `send <name> "<prompt>"`                               | Continue an **existing** agent: resume it if stopped, then give it the prompt. Errors if the name is unknown (never silently creates). |
| `ls`                                                   | Every agent's derived state — `running` / `idle` / `done` / `failed` / `stopped` — plus turns used, elapsed, session file.             |
| `logs <name> [--follow]`                               | Tail the agent's transcript/event log — the only window into a detached run.                                                           |
| `stop <name>`                                          | Gracefully abort the current run (`session.abort()`) and mark it stopped. Session file is retained.                                    |

Create (`spawn`) and continue (`send`) are deliberately **distinct**, so a mistyped name can never silently spawn a stray agent — the same typo-safety principle behind pi-link's CLI. `send` folds together what were separate `prompt` and `resume` verbs; there is no explicit "save" (sessions auto-persist to JSONL; the manifest is written at `spawn`). A **saved agent is just its JSONL + manifest**.

## Safety floor (non-negotiable)

The substrate caps nothing, so each runner must:

- **Budget:** a **turn ceiling** (count `turn_start`; `session.abort()` past the limit) and a **wall-clock ceiling**. Conservative default, overridable per `spawn`. (Auto-compaction keeps the context window healthy but is _not_ a cost cap.)
- **Pre-flight auth** at `spawn`: verify the model's credentials resolve _before_ detaching — an unattended agent cannot do interactive re-auth.
- **Headless-safe:** run with `hasUI:false`; a run that hits a UI-blocking extension fails cleanly rather than hanging.

That is the entire safety scope: one turn cap, one clock, one auth check.

## Relationship to pi-link

Orthogonal, and **not wired in v1.** pi-link is horizontal comms; this is vertical ownership. Later a runner can be spawned with the pi-link extension so a human can `link_prompt` the agent — at which point the runner stays the **single writer** for lifecycle ops and carries an authoritative name. Noted so v1 doesn't foreclose it; nothing built now.

## Biggest risk — de-risk this first

**A detached runner + its control pipe on Windows.** Spawning a child that survives its parent shell (`detached`, `stdio:'ignore'`, `windowsHide`), and a pipe the CLI can reconnect to. Walking skeleton before any feature work: `spawn --name w "task"` → close the shell → `ls` still shows `w` → `logs w` reattaches → `stop w` works. If that skeleton holds, the rest is SDK calls over a verified substrate.

Second risk: `stop`'s kill path. Prefer graceful `session.abort()`; before allowing any hard-kill, confirm the session loader tolerates a torn last JSONL line (a kill mid-append must not corrupt the saved agent).

## Scope (ratified 2026-07-02)

**v1 is pure lifecycle — NO admin levers** (`reset-to-zero`, `compact`, `fork`, `set-model`). This is the ratified minimum. It means the feature that started this exploration — programmatic reset-to-zero — is **not** in v1; it lands in **v1.1**. Because each runner is in-process SDK, those levers are trivially free to add later as pipe commands (`navigateTree`/`compact`/`fork` need no daemon and no upstream change).
