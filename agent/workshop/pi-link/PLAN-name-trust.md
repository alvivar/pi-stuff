# Name Trust Boundary

## Goal

Make hub-side handling of routed client messages (`chat`, `prompt_request`, `prompt_response`) consistent with how `status_update` is already handled: the hub treats the sender name as authoritative-from-socket, not client-supplied. Plus: stop the `/link-name` client branch from updating local identity before the hub has confirmed it.

This is **structural cleanup**, not a user-facing bugfix. Triggered by an external code-review report; verified against code; failure mode real but rare in practice (requires name collision + rename + traffic in the close→reconnect→welcome window). Ship after `0.72-alignment`, ideally before `monitor` mode adds more routing surface.

## Guardrail

If the diff grows beyond ~10 lines of substantive change, something is wrong. The whole point of this plan is that the existing `status_update` normalization already shows the right pattern — apply it once more, drop one optimistic assignment, done.

## Phases

### Phase 1 — Hub normalizes `from` on routed client messages

**Where.** `hubHandleClient` message dispatch, immediately before `routeMessage(msg)` (around line 680).

**What.** Mirror the `status_update` normalization at line 666-672. Non-mutating spread:

```ts
if (msg.type === "chat" || msg.type === "prompt_request" || msg.type === "prompt_response") {
  routeMessage({ ...msg, from: clientName });
}
```

**Effect.** Closes one consistency gap with downstream consequences:

- Direct `targetWs.send` carries authoritative `from`.
- `hubBroadcast(msg, msg.from)` excludes the right socket and broadcasts the right name.
- `hubClientByName(msg.from)?.send(errorMsg)` for target-not-found returns to the actual sender.
- Normalized `prompt_request.from` means the eventual `prompt_response.to` points back to the real requester; normalized `prompt_response.from` means the requester sees the real responder.

`terminal_joined` / `terminal_left` are already hub-authored. `status_update` is already normalized. No other paths need changes.

### Phase 2 — Drop optimistic local rename in `/link-name` client branch

**Where.** `index.ts:1402-1409`, the `else if (role === "client")` branch.

**What.** Don't assign `terminalName` locally; let `welcome` be authoritative (same pattern as fresh connect). Fix the notification wording to match.

```ts
} else if (role === "client") {
  savePreference();
  // welcome will assign terminalName authoritatively after reconnect
  ws?.close();
  _ctx.ui.notify(
    `Reconnecting requesting "${newName}" (hub may assign a different name if taken)...`,
    "info",
  );
}
```

"Reconnecting requesting" not "Reconnecting as" — the hub may dedupe to `newName-2`.

### Phase 3 — One-line comment at client open (optional)

If the diff already touches `connectAsClient`, add:

```ts
// Socket open = transport connected. welcome = identity authoritative.
```

Otherwise skip. Do **not** add a `"connecting"` role or any state-machine work; phases 1+2 close the practical gap.

## Sequencing

After `0.72-alignment` ships. Before `monitor` mode lands. Both phases in one publish — they're tiny and address the same bug class.

## Verification

Two manual checks are sufficient at this scale:

1. **Rename-to-taken-name does not lie locally.** A is `alpha`, B is `beta`. From B run `/link-name alpha`. Before `welcome`, B must not report itself as `alpha` — it may still show `beta`, or be temporarily disconnected. After welcome, it reports whatever the hub assigned (existing dedup behavior, not in scope).

2. **Code review of the spread.** Confirm `routeMessage({ ...msg, from: clientName })` reaches all four downstream paths in `routeMessage` (broadcast, direct send, target-not-found error, hub-targeted local handle). Reading the function once is enough.

The forged-`from` scenarios (manual `ws.send` of `chat`/`prompt_request` with a fake `from`) are useful as documentation of intent if anyone wants to write them down later, but don't gate the release on them.

## Out of scope

- **Persisted `preferredName` vs hub-assigned name divergence.** `/link-name` saves `preferredName = newName` before the hub confirms. If the hub dedupes to `newName-2`, the saved preference stays `newName` and will be requested again on the next reconnect. This is existing behavior and orthogonal to the trust boundary; don't try to solve it here.

## Done

- Phase 1: spread-normalization in place at the hub dispatch.
- Phase 2: optimistic `terminalName` assignment removed; notification wording corrected.
- (Optional) Phase 3 comment if the area was touched.
- CHANGELOG `Unreleased`, single line under `Fixed`. Suggested wording: *"Hub now uses its authoritative socket→name mapping when forwarding chat/prompt messages, matching the existing status_update behavior. Closes a name-mismatch edge case during rename-to-taken-name races."*

## Rollback

Phase 1: revert the spread to plain `routeMessage(msg)`. Phase 2: restore `terminalName = newName` before `ws?.close()`. Independent.

## Notes

- Framing in CHANGELOG and any commit message: consistency / hub-authority, not security. pi-link is loopback-only single-user — there is no untrusted client.
- Credit the external reporter in the commit message if their handle is known.
- Keep separate from `PLAN-pi-072-alignment.md` — different bug class, different publish.
