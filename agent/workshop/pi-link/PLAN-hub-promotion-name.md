# Hub Promotion Honors Pending Rename — DONE (0.1.12)

## Status

Folded into 0.1.12 alongside the name-trust fixes. Originally drafted as deferred follow-up; promoted to in-release after review caught that the regression was _introduced_ by the name-trust Phase 2 fix in the same release.

## Problem

`startHub` (line ~735) used `terminalName` to establish the hub's identity. `connectAsClient → register` (line ~778) used `preferredName ?? terminalName`. Asymmetry meant: rename + hub crashes during reconnect window → reconnect cycle falls through to `startHub` → promoted hub announces under the _old_ local name.

The asymmetry was latent before name-trust Phase 2 because the optimistic `terminalName = newName` assignment in `/link-name` covered for it — by the time the rename's `ws.close` triggered reconnect, `terminalName` already held the new name. Removing that optimistic assignment closed the cross-terminal misrouting bug but exposed this regression.

## Fix (implemented)

Reviewer (gpt) flagged that an unconditional `terminalName = preferredName ?? terminalName` in `startHub` would over-correct: in the stale-after-dedup case (client B has `preferredName=beta`, `terminalName=beta-2` because hub deduped), promotion would re-adopt the deduped-away `beta` and could swap identities with whichever client legitimately holds `beta` and reconnects later.

Adopted approach: gate the adoption behind a flag that's only true while a `/link-name` rename is pending confirmation.

Four touch sites, ~4 substantive lines:

1. State (line ~123):

   ```ts
   let pendingClientRename = false;
   ```

2. `welcome` handler (line ~487) — clear after authoritative assignment:

   ```ts
   terminalName = msg.name;
   pendingClientRename = false;
   ```

3. `/link-name` client branch (line ~1413) — set before close:

   ```ts
   savePreference();
   pendingClientRename = true;
   ws?.close();
   ```

4. `startHub` listening handler (line ~735) — consume on promotion:
   ```ts
   if (pendingClientRename && preferredName) terminalName = preferredName;
   pendingClientRename = false;
   ```

The flag is local extension state, not persisted. Cleared on welcome, on hub promotion, and on extension dispose by virtue of process exit. No teardown branch needs explicit reset.

## Why not just `preferredName ?? terminalName` in `startHub`

Reviewer's catch:

- Client C registered as `beta` (legitimately, hub-assigned).
- Client B requested `beta`, hub assigned B `beta-2`.
- B's `preferredName=beta` lingers (out-of-scope cleanup per name-trust plan), `terminalName=beta-2`.
- Hub dies before C reconnects.
- B promotes via `startHub`. Unconditional fallback would have B adopt `beta`.
- C reconnects → new hub (B) sees `beta` taken → assigns C `beta-2`.
- **Identities swap.**

The flag-gated version only adopts `preferredName` when a rename was actually in flight, preserving "promoted hub keeps its last hub-assigned identity" as the default.

## Verification

Code review against existing precedence in `register` (line 778) — both identity-establishing sites now agree on what the requested name is. Race scenario is fiddly to reproduce but the fix is mechanical.

Smoke pass on the rename happy-path (no hub crash) confirms `pendingClientRename` is set on `/link-name`, cleared on subsequent `welcome`, and the existing `/link-name` UX is unchanged.

## Out of scope

- **Persisted `preferredName` cleanup when hub dedupes.** Still out of scope (noted in `PLAN-name-trust.md`). This fix doesn't touch persistence.
- **Reconnect-promotion policy.** Whether `scheduleReconnect → initialize` should ever fall through to `startHub` (vs. retrying connect indefinitely) remains a separate product question.

## CHANGELOG

Added 5th `Fixed` bullet under `Unreleased`, framed as same-release follow-up to the `/link-name` no-optimistic fix:

> **Hub promotion now preserves a pending client rename request.** [...]
