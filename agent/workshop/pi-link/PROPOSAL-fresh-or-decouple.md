# Proposal — `--fresh` flag or full link-name / session-name decoupling

**Status**: pending requester clarification + user decision
**Source**: forum request from a pi-link user (not internal)
**Date noted**: 2026-05-03
**Target if implemented**: 0.1.13 (option 1) or 0.2.0 (option 2)

---

## Original request (verbatim)

> Any way we could have a cli flag for setting the link name and then later have a separate flag to determine whether it should try to resume a session by that name or not? Sometimes I'd want to resume a session and sometimes not for more generic names

---

## What's actually being asked

Decouple **link identity** from **session resume**. Currently `pi-link <name>` does both: sets the link name AND resumes (or creates) a session by that name. The user wants the option to use a link name without auto-resuming a same-named session.

## Is the pain real?

Yes, narrowly. With 0.1.12 cwd-scoping, `pi-link worker` from `~/projects/A` doesn't accidentally resume `~/projects/B`'s worker session. But within a single cwd, repeated `pi-link worker` always auto-resumes. For unique names (`builder@pi-link`, `opus-feature-X`) this is fine. For generic names (`worker`, `dev`, `test`) the resume-by-default is occasionally wrong.

## Today's workarounds

- Use a more specific name (`worker-S503`)
- Don't use generic names
- Manually delete the stale session file
- (Pi's `--session-dir`/`--no-session` are rejected as managed flags now)

---

## Two implementation branches

The clarifying question sent to the requester: do they want the minimal form, or full decoupling?

### Branch A — `--fresh` flag (minimal)

```
pi-link <name> --fresh         # or --new, or --no-resume
```

Effect: skip session lookup, generate a timestamped session path, keep `<name>` as link identity. Link layer already dedups collisions (`<name>-2`).

**Cost**: ~20 lines in `bin/pi-link.mjs`.

- Parser learns `--fresh` as a known flag
- Skip `findSessionsByName` when set
- Generate unique session path (timestamped) and forward to Pi
- Reject `--fresh --global` combination as no-op
- One CHANGELOG bullet, one README sentence

**Naming options**:

- `--fresh` — short, clear, novel, doesn't collide. **Recommended.**
- `--new` — conventional (`git checkout -b`, `tmux new-session`) but ambiguous next to "create a new pi-link" mental model
- `--no-resume` — explicit, mirrors npm `--no-*` style; longer
- `--no-session` is **taken** by Pi (already rejected as managed flag)

**Skill update**: not needed (CLI-level; agents don't invoke `pi-link` from session).

**Sizing**: 0.1.13.

### Branch B — Full link/session decoupling

```
pi-link --name <linkname> --session-name <sessionname>
```

Adds two distinct flags. `pi-link <name>` still works as shorthand (link = session = `<name>`).

**Cost**: meaningfully larger.

- New flags `--name` and `--session-name`, with positional `<name>` becoming sugar
- `--session-name` collision with Pi's `--session` — must namespace clearly without confusion
- Validation matrix grows: `--name X --session-name Y --global` interactions
- More README, more CHANGELOG, more help text
- Shape change deserves a minor version bump

**Sizing**: 0.2.0.

**Risk**: premature generalization. Nobody has asked for two distinct names yet — only "I want fresh sometimes." Branch A is a _special case_ of B (session name = `<linkname>-<timestamp>`).

---

## Recommendation (pending requester reply)

**If they confirm `--fresh` covers their case → Branch A.** Ship as 0.1.13, watch demand for full decoupling, revisit if it materializes.

**If they actually want two distinct names → Branch B.** But verify with concrete use case ("I want to be `worker` on the link AND resume an unrelated session named `feature-x`") before committing. Generic decoupling without a concrete need is feature creep.

**My lean even if they say B**: implement A first as a stepping stone, generalize only if demand persists.

---

## Edge cases worth thinking through (Branch A)

- **Two `worker`s, same cwd**: one resumes, the other `--fresh`. Link dedups second to `worker-2`. User's "I want to be `worker`" intent partially honored. Acceptable; mirrors existing collision behavior.
- **Fresh sessions accumulating on disk**: each `--fresh` creates a new file. Pi already has session cleanup tooling — pi-link doesn't need to manage it.
- **`--fresh --global`**: explicitly reject as a contradiction (we're not searching, so scope flag is meaningless). Mirrors existing validation guardrails.

---

## Open questions

1. Requester's actual need — `--fresh` or full decoupling? (Awaiting reply.)
2. If `--fresh`: where does the auto-generated session path live? Probably the same dir Pi would auto-pick (no special handling needed); pi-link just doesn't seed it from existing files.
3. If `--fresh`: should the flag accept a value (`--fresh=force` for some future variant)? **No** — keep it boolean. YAGNI.

---

## Next step

Wait for requester's reply on the `--fresh` vs decoupling question. Then either:

- (A) Draft `PLAN-fresh-flag.md` and implement → 0.1.13
- (B) Draft `PLAN-link-session-decouple.md` and implement → 0.2.0
- (C) Park if requester drops it; revisit if more users ask

This file is the resume point.
