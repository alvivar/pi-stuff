# pi-dock — backlog

What is not built or decided yet. Contracts live in `DESIGN.md`, shipped work in
`CHANGELOG.md`. Delete an item when it ships.

## To do, in priority order

1. [ ] **Unix runtime test** — the regression and the smoke have never run on Unix; the Unix
       paths (socket, signals, stale-socket probe) have seen only the owner's use on Android
       (Termux). Run the regression, and the smoke with authorization, on the owner's Linux
       server and on Termux. The README says Unix is little tested. Then decide:
       - **Stale-socket race:** after `EADDRINUSE`, `recoverUnixListen` probes the socket,
         unlinks it if nobody answers and listens again; another runner can take it between
         the probe and the unlink, so two wakes over an orphaned socket could leave two
         runners. Deleting the socket before `listen` races too. A fix must prove that two
         runners exclude each other. Manifest creation relies on that exclusion as well: two
         create runners could both publish, and the last rename wins.
       - **Probe failure:** a failed probe logs `failed`; verified only on a simulated
         platform.
       - **Simpler listen errors:** `pipe.mjs` and the runner coordinate through marks on
         error objects (`piDockRetrying`, `piDockFatal`) and listener order. An async `serve`
         that resolves listening or rejects with a plain error would remove both marks. It does
         not fix the race by itself.
2. [ ] **`set` racing `start` is unsupported: say so** — `set` checks that the agent is off,
       then rewrites the manifest; a `start` in between runs the old config until the next
       restart (nothing is lost). Recommended: state in README and skill that `stop` → `set`
       → `start` must not overlap; a lock is not justified.
3. [ ] **Comment the `abort()` catch** — `shutdown` does `session.abort().catch(() => {})`. If
       `abort()` ever rejected, the log would say `stopped` untruthfully; whether it can is not
       established. Recommended: a comment stating the assumption; log `failed` only if it is
       ever seen.
4. [ ] **Extension-registered providers** in `models` and spawn/set preflight — both use a
       bare `ModelRuntime`, so providers registered by extensions are not visible and
       spawn/set can reject a valid model. Only matters with extension providers.
5. [ ] **ls uptime** — time since the current runner booted (latest `spawned`), next to age.
       `logs` and `show` already tell restarts apart.
6. [ ] **Narrow two catches** (low) — `handshake` treats any manifest read error (corrupt,
       `EACCES`) as "not there yet" for 20 s; catch only `ENOENT`. `agentState` falls back to
       the log's state on any non-timeout error, even one that doesn't prove the agent is off.

## Release

7. [ ] **Publish 0.4.1** — the owner publishes by hand.

## Decide later

- **SDK upgrades:** the SDK is pinned to exactly `1.4.0`. When to move to a newer Pi, and
  whether each upgrade needs a paid smoke.

## Ideas — need design before building

- `fork`.
- **Summary retention test** (paid): compaction experiments only recalled facts from the kept
  tail. Plant a fact only in the summarized prefix and ask a question that doesn't hint at it.
- **Readability nits**, not defects: the pipe server accepts several lines per connection
  though the client sends one; single-use `thinkingOption`; an unparenthesized nested ternary
  for the runner's state; `confirmPipeAbsent` checks `ETIMEDOUT` instead of `isTimeout()`;
  `handshake`'s unused `timeoutMs` parameter; `sendCommand`'s XOR for "file or words";
  `setCommand` lists the manifest fields one by one.

## Accepted limits — revisit only on a concrete case

| Limit | Why it is accepted | Revisit if |
|---|---|---|
| A wake that fails before owning the pipe (manifest gone) appends `failed` without truncating; on an already torn log the two lines merge and the next wake can't repair it. | Only the pipe owner may touch the log; needs a torn line plus a deleted manifest. | Such a log shows up. |
| A `spawn` racing a stopped agent of the same name can leave an extra `spawned`; `ls` shows `failed` until the next wake. | No damage; the next wake fixes it; very rare race. | Seen in real use. |
| While a runner starts, `start`/`stop`/`wait` wait up to 3 s, then say `not responding`; `ls`/`show` show `not-responding`. | True: it doesn't answer yet. Before, a second runner was launched. | A normal boot takes over 3 s. |
| A failed log write from session events (`turn`, `text`, `external`) or `onError` throws inside the SDK; in tests it ended in `fail()`. | The observed outcome is already explicit. | A log failure that does not end in `failed`. |
| Extension errors after shutdown begins are not logged, including `session_shutdown` handler errors. | Keeps `stopped`/`failed` the last event. | Shutdown errors need diagnosing. |
| A `session_shutdown` handler that hangs keeps the agent from exiting; `stop` reports `did not exit within 5s`. | Pi waits for it the same way on quit; the failure is visible. | A real extension hangs there. |
| A create that fails (e.g. no model) logs `failed` but not the extension load errors. | Load errors are logged for agents that boot. | They are needed to diagnose a failed create. |
| `textFromMessage` trusts that `turn_end` carries an assistant message. | Guaranteed by the SDK 1.4.0 emitters, not by its public types. | The SDK is upgraded. |
| A pipe request relies on `'close'` (no `'end'` handler). | Correct with our runner, the only peer. | Another process talks on the pipe. |
| A non-JSON pipe reply is reported with Node's raw error, which shows its first 10 characters. | The pipe belongs to our own runner. | Sensitive data crosses the pipe. |
| The smoke checks the requested thinking level in the manifest, not the level the model applies. | For `gpt-6-luna`, `high` is not clamped. | The smoke runs on another model or level. |
| With the real theme, `theme.fg` returns ANSI-colored text, which nothing in a runner shows. | Only the UI and theme changed. | An extension writes theme output somewhere that is read. |
| A split-turn compaction summarizes only the prefix; the summary can say work is "not done yet" while the kept messages show it finished. | SDK design; rewriting summaries in pi-dock isn't justified. | An agent redoes work or resends messages after compacting. |

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
