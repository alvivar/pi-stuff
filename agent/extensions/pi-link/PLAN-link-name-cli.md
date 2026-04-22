# Plan: `--link-name` Flag + Session Resume by Name

## Problem

Users want `pi --link-name worker-1` to:

1. Connect to the link with terminal name "worker-1"
2. Resume a session named "worker-1" if it exists, create a new one if not

Pi's `--session` only resolves by file path or UUID prefix, not by display name. Extensions can't control session selection (it happens before `session_start`).

## Solution: Two Layers

### Layer 1 — Extension Flag (`--link-name`)

Register `--link-name <name>` as a custom CLI flag in pi-link.

In `session_start`:

- Read `pi.getFlag("link-name")`
- If present: set `terminalName`, set `preferredName`, persist to session, auto-connect (implies `--link`)
- Optionally call `pi.setSessionName(name)` if session has no name yet (for resume discoverability)

~10 lines. Pure extension code.

**Usage:** `pi --link-name worker-1`

### Layer 2 — Wrapper CLI (`pi-link start`)

Node.js script exposed as package `bin` in pi-link's `package.json`.

**Resolution logic:**

1. Scan `~/.pi/agent/sessions/` for JSONL files
2. For each: read last `session_info` entry, extract `name`
3. Exact match on name (not prefix, not fuzzy)
4. Search order: local sessions (current cwd) first, then global
5. If one match → `pi --session <path> --link-name <name>`
6. If no match → `pi --link-name <name>` (new session)
7. If ambiguous (multiple exact matches) → print candidates, fail

Then `spawn("pi", args, { stdio: "inherit" })`.

**Usage:** `pi-link start worker-1`

~50-80 lines Node.js. Cross-platform. No Pi internal dependencies.

## Session Data Structure

Sessions stored at: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

JSONL entries relevant to us:

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"C:\\..."}
{"type":"session_info","name":"worker-1","id":"...","timestamp":"..."}
```

- Session name = last `session_info` entry's `name` field
- Pi's `resolveSessionPath()` matches `session.id.startsWith(arg)` — ID only, not name
- `SessionManager.list()` returns `{ path, id, cwd, name, created, modified, ... }`

## Key Pi APIs

- `pi.registerFlag(name, { type, description, default })` — register custom CLI flag
- `pi.getFlag(name)` — read flag value
- `pi.setSessionName(name)` — set session display name
- `pi.getSessionName()` — get current session name
- `--session <path|id>` — Pi built-in: resume specific session

## Design Decisions

- **Exact name match only** — less surprising than prefix/fuzzy
- **Local-first search** — mirrors Pi's own session resolution
- **Ambiguity = fail** — print candidates, don't silently guess
- **`--link-name` implies `--link`** — no need for both flags
- **Session name set only if blank** — don't overwrite existing session names
- **Wrapper is outside the extension** — session selection is a startup concern
- **Node.js, not shell** — cross-platform, robust JSONL parsing, Windows support
- **Direct JSONL scanning** — no dependency on Pi internals

## Open Questions

- [ ] Should `pi-link start` accept additional Pi flags? (e.g., `pi-link start worker-1 --model sonnet`)
- [ ] Should the wrapper support `pi-link list` to show named sessions?
- [ ] Package bin availability: global install puts it on PATH; local install may not
- [ ] Should `--link-name` without Layer 2 also try to match sessions? (No — extensions can't control session selection)
- [ ] What if the user has sessions with duplicate names across different cwds?

## Implementation Order

1. Layer 1: `--link-name` flag in extension (~10 lines)
2. Layer 2: `pi-link` CLI wrapper script (~50-80 lines)
3. Update README, CHANGELOG, SKILL.md
4. Test: `pi --link-name test`, `pi-link start test` (new), `pi-link start test` (resume)
