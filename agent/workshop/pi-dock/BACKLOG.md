# pi-dock — backlog

Everything not yet built or decided. Contracts live in `DESIGN.md`; shipped work lives in
`CHANGELOG.md`. Delete an item when it ships. Updated 2026-10-06, after the 0.3.0 code review
(polaris and vega), its fixes, and two paid compaction experiments.

## Backlog, in priority order

1. [ ] **Report the split-turn compaction bug to the SDK** — owner action. The issue is
       drafted in `docs/sdk-issue-compaction-instructions.md` for
       https://github.com/earendil-works/pi (`packages/coding-agent`): when compaction cuts
       inside a turn, custom instructions never reach the turn-prefix summary, and with no
       earlier history they reach no model call at all. Seen in a real run (the summary began
       "No prior history."). Nothing to change in pi-dock; a fixed SDK is just a dependency
       bump.
2. [ ] **Unix runtime test** — Unix paths (socket, signals, stale-socket probe) are inspected
       only. Run the regression, and the smoke with authorization, on the owner's Linux
       server. Then decide:
       - **Stale-socket race:** after `EADDRINUSE`, `recoverUnixListen` probes the socket,
         unlinks it if nobody answers and listens again; another runner can take it between
         the probe and the unlink. Deleting the socket before `listen` is also a race (vega).
         Any fix must prove that two runners exclude each other.
       - **Probe failure:** since `fee5903` a failed probe logs `failed` instead of exiting
         silently. Verified only with a simulated platform.
       Windows is unaffected; on Unix two simultaneous wakes over an orphaned socket could
       leave two runners.
3. [ ] **Extension-registered providers** in `models` and spawn/set preflight — both use a
       bare `ModelRuntime`, so providers registered by extensions are not visible and
       spawn/set can reject a valid model. Only matters for setups with extension providers.
4. [ ] **ls uptime** — time since the current runner booted (latest `spawned`), next to age.
       Low: `logs` (`spawned` pid) and `show` are enough to tell restarts apart.

## Release — only if pi-dock is going to be used by others

5. [ ] **Publish 0.3.0** — cut locally in `4f2e414` (no tag, not pushed). The owner publishes
       by hand. `package.json` has no `description`.

## Ideas — need design before building

- `fork`.
- **Summary retention test** (paid): both compaction experiments recalled facts that sat in
  the kept tail, not in the summarized prefix. To test the summary itself, plant a fact only in
  the prefix and ask a question that doesn't hint at it. Auto-compaction, failures and repeated
  compactions with a real model are also unobserved.

## Accepted limits — revisit only on a concrete case

| Limit | Why it is accepted | Revisit if |
|---|---|---|
| A wake that fails before owning the pipe (manifest gone) appends `failed` without truncating; on an already torn log the two lines merge and the next wake can't repair it. | Only the pipe owner may touch the log; needs a torn line plus a deleted manifest. | Such a log shows up. |
| A `spawn` racing a stopped agent of the same name can leave an extra `spawned`; `ls` shows `failed` until the next wake. | No damage; the next wake fixes it; very rare race. | Seen in real use. |
| While a runner starts, `start`/`stop`/`wait` wait up to 3 s, then say `not responding`; `ls`/`show` show `not-responding`. | True: it doesn't answer yet. Before, a second runner was launched. | A normal boot takes over 3 s. |
| A failed log write from session events (`turn`, `text`, `external`) or `onError` throws inside the SDK; in tests it ended in `fail()`. | The observed outcome is already explicit. | A log failure that does not end in `failed`. |
| Extension errors after shutdown begins are not logged; extension load (import) errors never reach `onError`. | Keeps `stopped`/`failed` the last event; loading is a separate SDK path. | Shutdown errors need diagnosing. |
| `textFromMessage` trusts that `turn_end` carries an assistant message. | Guaranteed by the SDK 0.99.2 emitters, not by its public types. | The SDK is upgraded. |
| A pipe request relies on `'close'` (no `'end'` handler). | Correct with our runner, the only peer. | Another process talks on the pipe. |
| A non-JSON pipe reply is reported with Node's raw error, which shows its first 10 characters. | The pipe belongs to our own runner. | Sensitive data crosses the pipe. |
| The smoke checks the requested thinking level in the manifest, not the level the model applies. | For `gpt-6-luna`, `high` is not clamped. | The smoke runs on another model or level. |
| With the real theme, `theme.fg` returns ANSI-colored text, which nothing in a runner shows. | Only the UI and theme changed. | An extension writes theme output somewhere that is read. |
| A split-turn compaction summarizes only the prefix; the summary can say work is "not done yet" while the kept messages show it finished. Not tied to a low `keepRecentTokens`. luna read it correctly twice. | SDK design; rewriting summaries in pi-dock isn't justified. | An agent redoes work or resends messages after compacting. |
| Compaction instructions are dropped for split turns (item 1). | SDK bug; reported upstream, not patched here. | Instructions must guide the turn prefix. |

## Not needed

- A native "follow until pattern" or `wait <name>` without id: a team's conclusion is an
  application fact, and "idle" is not stable with callbacks. A small observer polling
  `logs --raw` for a structured `text` marker is the right tool: see README, "Observer for
  team completion".
- One reader for the end of the log: `lastLogLine`, `lastCompleteLogEvent` and
  `readCompleteLines` have different contracts; merging them trades clarity for lines.
- A command map instead of the `if/else` dispatch: a preference, not a defect.
- Merging `getAvailable` and `getAuth` in `verifyModelAuth`: not shown to be equivalent.
- Faster `wait`/`logs --follow` than rereading the log every 500 ms: no measured problem.

## Watch

- `bin/pi-dock.mjs` is ~840 lines, much of it help text. Fine today; split the help out only
  if it keeps growing.
