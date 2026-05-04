# Proposal — Restore `--link-name` to pi-link extension

**Status**: direction confirmed with requester, ready for plan promotion
**Source**: forum request from a pi-link user (not internal)
**Date noted**: 2026-05-03
**Target**: 0.1.13 (link-name only); `--session-name` deferred to a later release pending upstream Pi PR

---

## Original request (verbatim)

> Any way we could have a cli flag for setting the link name and then later have a separate flag to determine whether it should try to resume a session by that name or not? Sometimes I'd want to resume a session and sometimes not for more generic names

## Direction agreed with requester

After a clarifying exchange:

- Requester preferred **full decoupling** of link name from session name, not a `--fresh` shorthand.
- We confirmed we can ship the link-name half **immediately**, without waiting for upstream Pi changes.
- Session-name decoupling depends on an upstream Pi PR (not yet merged) — deferred to a later pi-link release.
- Requester confirmed: "That would be good for now."

So the committed scope is: **restore `--link-name <name>` as a pi-link extension flag**, decoupled from session resolution. `--session-name` comes later.

---

## What "restore" means

`--link-name` previously existed in pi-link, was removed when the `pi-link <name>` wrapper became canonical. The original implementation was "buggy/hacky" because it tried to also affect session selection. The restored form is the **clean** version:

- `pi --link-name foo` → terminal joins the link as `foo`
- **Zero effect on session** — Pi's session handling (default behavior, `--session`, `--continue`) is untouched
- If `foo` collides with an existing terminal, the hub dedups (`foo-2`) per existing collision rules
- No file lookups, no resume logic, no cwd scanning

This is what the requester actually wants: link identity, divorced from session lifecycle.

---

## Why `--fresh` was dropped

The earlier minimal branch (`pi-link <name> --fresh`) is now obsolete. Decoupling subsumes it: a user who wants "be `worker` on the link without resuming" simply runs `pi --link-name worker` and lets Pi pick whatever session it would have picked anyway (or runs Pi with `--no-session`, etc.).

`--fresh` would have been a special case of decoupling — and decoupling is what the requester explicitly asked for. No reason to ship the special case first.

---

## Implementation outline

### Extension side (`index.ts`)

- Use Pi's extension flag API: `pi.registerFlag("link-name", { description: ..., type: "string" })`, then read with `pi.getFlag("link-name")`. **Do not parse `process.argv` manually** — Pi already collects unknown long flags and applies them to registered extension flags, supporting both `pi --link-name foo` and `pi --link-name=foo`. Bonus: gets help integration and missing-value diagnostics for free.
- If the flag is set and non-empty, use as the terminal's link identity and **imply startup connect** (mirroring how `PI_LINK_NAME` behaves today).
- **Critical guard**: the public `--link-name` path must **not** call `pi.setSessionName`. The current internal `PI_LINK_NAME` handler does `if (!pi.getSessionName()) pi.setSessionName(flagName);` — this is exactly the "session interference" the restored form must avoid. Use a shared normalization helper but track the source: env/internal wrapper may retain the session-name fallback if desired; public `--link-name` must not.
- Persist link identity (append a `link-name` custom entry) on success, matching `/link-name`, wrapper behavior, and `pi-link list` discovery. Still don't touch session name.
- Reject empty / whitespace-only values with a clear error (mirrors existing validation).

### Precedence ladder (resolved)

```
--link-name flag  >  PI_LINK_NAME env  >  saved link-name  >  session name  >  random
```

`--link-name` is the public surface. `PI_LINK_NAME` remains the internal wrapper handoff mechanism — the public flag is **not** implemented by setting `PI_LINK_NAME` wholesale (would re-inherit the session-name side effect).

### `pi-link` wrapper CLI (`bin/pi-link.mjs`)

The wrapper currently rejects `--link-name`:

```
--link-name was removed. Use: pi-link <name>
```

After restoration, this rejection message is misleading. **Decision: keep wrapper rejecting `--link-name`, update message.** Reason: the ambiguity case `pi-link foo --link-name bar` has no good "which wins?" answer; sidestep entirely by keeping surfaces distinct:

- `pi-link <name>` → combined session-by-name + link name workflow
- `pi --link-name <name>` → link identity only, normal Pi session behavior

New rejection message:

```
--link-name is not accepted by the pi-link wrapper. Use 'pi-link <name>' for combined link+session, or run 'pi --link-name <name>' directly to set the link name without session resolution.
```

Mirrors npm wrapper pattern: `npm install <pkg>` is the high-level surface; raw `npm` flag invocations are the lower-level surface. The UX divide is acceptable and clarifies the model.

---

## CHANGELOG bullet (drafted)

> **Added `--link-name <name>` for link-only startup naming.** Run `pi --link-name worker` to join the link as `worker` while leaving Pi's normal session selection/resume behavior untouched. This restores link-name startup naming in a cleaner form than the previous session-coupled implementation: it sets only the pi-link identity, with hub collision handling unchanged. Use `pi-link <name>` when you want the combined session-by-name + link-name workflow. Empty or whitespace-only names are rejected.

Framing intentionally avoids "we reverted" — the previous removal targeted the session-coupled implementation; the restoration is the clean link-only form.

## Risk / edge cases

- **Wrapper rejection message stays semantically true**: the `pi-link` wrapper itself still doesn't accept `--link-name`. The "removed" verb in the current message becomes inaccurate; new message says "not accepted here, use X instead" without claiming the flag was removed.
- **`PI_LINK_NAME` documentation rules still hold**: per session rules, `PI_LINK_NAME` is internal-only and must not appear in README/skill. `--link-name` becomes the public surface for the same concept; CHANGELOG retains technical history including env-var mechanics.
- **Critical guard against re-introducing the bug**: implementation must not piggyback on the existing `PI_LINK_NAME` handler that calls `pi.setSessionName` as a fallback. Public `--link-name` is link-only, period.

---

## Skill update

**Not needed.** `--link-name` is invoked at Pi-process start, before agents have a tool surface. Agents don't run `pi` from inside a session. The skill is for in-session coordination via `link_list`/`link_prompt`/`link_send` — none of which change.

---

## Future work (after this ships)

- **`--session-name`**: requires upstream Pi PR exposing session naming/resolution to extensions. Track separately. When merged and released, pi-link adds `--session-name <name>` that pairs with `--link-name <other>` for full decoupling.
- **Eventually retire the `pi-link` wrapper?**: if `pi --link-name X --session-name Y` becomes the canonical way, the wrapper's value drops. But the wrapper still does session-by-name resolution (cwd-scoped, `--global`, etc.) which is genuinely useful for most users. Likely keeps its place as the ergonomic shorthand.

---

## Status

**Reviewed by gpt@pi-link, design clean.** Five amendments folded into this proposal:

1. Use `registerFlag`/`getFlag`, not raw argv parsing
2. `--link-name` wins over internal env (precedence ladder above)
3. `--link-name` implies link connect (mirrors current `PI_LINK_NAME` behavior)
4. Public `--link-name` does **not** call `pi.setSessionName` (critical guard)
5. Wrapper keeps rejecting with the new clearer message

Ready for promotion to `PLAN-link-name-flag.md`. The PLAN should add: concrete diff scope (file:line touchpoints), test strategy (verify session name unaffected when `--link-name` is set; verify precedence ladder; verify empty-value rejection; verify wrapper rejection message), and any final review pass before patching workshop.

This file is the resume point.
