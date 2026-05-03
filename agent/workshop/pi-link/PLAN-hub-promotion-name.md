# Hub Promotion Honors Preferred Name

## Goal

After a rename, if the client falls through to `startHub()` (because the existing hub vanished during the reconnect cycle), the hub should announce under the requested name, not the pre-rename name.

This is a **narrow regression introduced by `name-trust` Phase 2**: removing the optimistic `terminalName = newName` assignment closed the cross-terminal misrouting bug, but exposed a latent inconsistency between the two reconnect destinations:

| Path                           | Uses                              |
| ------------------------------ | --------------------------------- |
| `connectAsClient` → `register` | `preferredName ?? terminalName` ✓ |
| `startHub` (line 733-737)      | `terminalName` only ✗             |

`scheduleReconnect → initialize` tries `connectAsClient` first; if it fails (no hub) it falls through to `startHub`. So the rare-but-real failure case is: rename + hub crashes during reconnect window → promoted hub announces under the old name.

## Guardrail

One-line fix. If the diff grows, the plan is wrong about the cause.

## Fix

In `startHub()`, immediately before `role = "hub"`, adopt the preferred name as authoritative (the hub IS the authority — no dedup concern):

```ts
if (preferredName && preferredName !== terminalName) {
  terminalName = preferredName;
}
```

Placed inside the `server.on("listening", ...)` handler, just before `connectedTerminals = [terminalName]` so the join broadcast and notify use the right name.

Mirrors the existing `register` precedence (`preferredName ?? terminalName`) at the only other identity-establishing site.

## Out of scope

- **Persistence cleanup when hub dedupes.** If a client requests `alpha`, hub assigns `alpha-2`, the saved `preferredName` still reads `alpha`. This was already noted as out-of-scope in `PLAN-name-trust.md` and isn't affected by this fix.
- **Connection retry promotion policy.** Whether `scheduleReconnect` should ever fall through to `startHub` at all (vs. retrying connect indefinitely) is a separate product question. Today it does, so this plan handles that case.

## Verification

Single manual scenario:

1. Two terminals A (`alpha`, hub) and B (`beta`, client).
2. From B, run `/link-name gamma`. B closes its socket and starts reconnecting.
3. While B is between reconnects, kill A's process (or `disconnect` its hub).
4. B's next reconnect cycle: `connectAsClient` fails → `startHub` succeeds.
5. **Expected**: B's `notify` says `Link hub started on :PORT as "gamma"`. `link_list` from a new terminal joining shows `gamma`, not `beta`.
6. **Without the fix**: B announces as `beta`, the old name.

If reproducing the race is fiddly, code-review the diff against `register`'s precedence pattern — they should be visually identical.

## Done

- One-line guarded reassignment in `startHub`.
- CHANGELOG `Unreleased` entry under `Fixed` (one bullet, references that it's a follow-up to the name-trust fixes from 0.1.12).
- Manual scenario passes, or a code-review confirmation that the precedence matches `register`.

## Rollback

Revert the one-line reassignment. Restores the regression; no other code is affected.

## Notes

- This plan exists because `PLAN-name-trust.md` Phase 2 quietly relied on `terminalName = newName` being optimistic to feed `startHub`. Removing it surfaced the latent bug. Don't treat it as a separate bug class.
- Keep separate from any larger reconnect-policy work; this is the minimum to restore intended behavior.
