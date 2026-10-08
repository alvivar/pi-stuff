# pi-dock 0.3.0 — code review

Two independent reviews of HEAD `5e544ea` (pi-dock 0.3.0, SDK 0.99.2), consolidated:

- **polaris:** read `bin/pi-dock.mjs` and `src/*.mjs` against the SDK sources. Lens: simplest
  readable solution, redundant checks, masked failures. Did not review `test/` in depth; ran
  nothing.
- **vega:** read the CLI, runtime, DESIGN, BACKLOG, relevant regression sections and the SDK
  implementation; syntax checks passed. Reproductions ran from stdin with in-memory doubles and
  real SDK methods. None is an end-to-end spawn/stop/start test. Did not run the regression,
  the smoke, paid calls, real agents or Unix.

Already decided in `BACKLOG.md` (accepted limits, "Not needed") and in C16 is not reopened,
except V2, which revisits an accepted limit with new evidence. polaris checked V1–V3 against
the SDK sources cited.

IDs: **V** = vega, **P** = polaris.

**Current state:** HEAD `fa60cd6`, regression 81/81. V1, V2, V3, P1 and P3–P7 are done (see
"Completed", at the end). What remains needs an owner decision, the Unix test, or was not
taken.

## Pending, in priority order

| ID  | Kind           | Finding                                             | Needs                       |
| --- | -------------- | --------------------------------------------------- | --------------------------- |
| P8  | Decision       | `shutdown` swallows `abort()` errors                | owner: comment or log       |
| V4  | Decision       | `set` racing `start`: is it supported?              | owner: state the assumption |
| D7  | Decision       | What happens to this file                           | owner                       |
| P2  | With Unix test | Unix listen errors travel as flags on error objects | Unix server                 |
| P9  | Low            | Broad catches in `handshake` and `agentState`       | not taken                   |
| —   | Optional       | Readability items                                   | not taken                   |

## Owner decisions

### P8. `shutdown` swallows `abort()` errors

- `src/runner.mjs`, `shutdown()`: `await session?.abort().catch(() => {})`. If `abort()` ever
  rejected, the log would say `stopped` untruthfully; without the catch, shutdown would never
  log a terminal event. Whether it can reject is not established: its idle wait only resolves,
  but `abort()` also calls other methods (vega's correction; an earlier version of this review
  claimed it rejects only if `waitForIdle` does).
- **Options:** state the assumption in a comment, or log it as `failed`. **Recommendation:** the
  comment; no observed risk. V1 (`fa60cd6`) left this line unchanged.

### V4. `set` racing `start`: is it supported?

- **Where:** `bin/pi-dock.mjs`, `setCommand`: `confirmPipeAbsent` → optional `preflightSpawn`
  → `rewriteManifest`.
- **What:** the "powered off" observation is not held through preflight and the rewrite. A
  concurrent `start` can bring the runner up before `set` rewrites the manifest. Two concurrent
  `set`s may deserve the same question; not reproduced.
- **Evidence (vega):** ran the exact `setCommand` in a vm with in-memory doubles; the preflight
  mock simulated a `start`, and `rewriteManifest` then ran with the agent live. A valid
  interleaving, not an end-to-end concurrency test.
- **Options:** if `set` must be strictly powered-off under concurrency, the operation needs
  exclusion (a second status check only narrows the window). If concurrent `set`/`start` is
  unsupported, say so in the docs. vega assigned no severity and prescribed no lock.
- **Recommendation (polaris):** declare it unsupported. `set` is a human or operator action on
  an agent they just stopped, and no real use has hit it. In the race the agent runs the old
  config while the manifest says the new one, until its next restart; nothing is lost.

### D7. What happens to this file

- **Recommendation:** once the decisions above are settled or deferred, move what remains into
  `BACKLOG.md` and delete this file, as with the previous review. History lives in the
  CHANGELOG and git.

## With the Unix test (BACKLOG item 2)

### P2. Unix listen errors travel as flags on error objects

- `src/pipe.mjs` (`emitServerError`, `listenUnix`, `recoverUnixListen`) and the runner's
  `server.on('error')` handler. They coordinate through marks on error objects
  (`piDockRetrying`, `piDockFatal`) and re-emitted `'error'` events. Correctness depends on
  listener registration order (`listenUnix` must mark an error before the runner's listener
  sees it). On error, the runner's await for `'listening'` never resolves; it exits sideways
  through the handler (`fail` → `process.exit`).
- **Fix:** make `serve` async: resolve with a listening server, or reject with a plain error
  (`EADDRINUSE` when another runner owns it, or the probe failure). The Unix retry becomes
  linear (`listen` → probe → `unlink` → `listen`); the runner does
  `try { server = await serve(...) } catch`. `emitServerError`, both marks and the runner's
  filter go away.
- **Timing:** this is the never-executed Unix path. Do it together with the Unix test, not
  before.

## Not taken

### P9. Broad catches in `handshake` and `agentState` (low)

- `bin/pi-dock.mjs`, `handshake`: `readManifest(...).catch(() => null)` treats a corrupt
  manifest or `EACCES` as "not there yet" for 20 s before "handshake failed". Catch only
  `ENOENT`.
- `agentState` falls back to the log's state on any non-timeout error, including errors that do
  not prove the agent is off. Display only; acceptable if stated.

### Optional — readability only

- The pipe server handles several lines per connection and skips empty ones (`src/pipe.mjs`,
  `serve`); the client sends exactly one line per connection.
- `thinkingOption` is used once, while the model uses an inline spread; use
  `...(thinking && { thinkingLevel: thinking })`.
- Unparenthesized nested ternary for the state in the runner's status handler: correct, slow to
  read.
- `confirmPipeAbsent` checks `error.code === 'ETIMEDOUT'` instead of `isTimeout()`.
- `handshake(name, timeoutMs = 20000)`: the parameter is never passed; a constant reads better.
- `sendCommand`: `(file === undefined) === (words.length === 0)` is a clever XOR; spell out
  "exactly one of the two".
- `setCommand` lists the manifest schema field by field; with no backward compatibility,
  `{ ...manifest, model, thinking, flags }` is simpler.

### Not recommended

Neither review recommends cosmetic refactors beyond the list above, generic state or event
frameworks, new dependencies, or wholesale guard removal. The Unix stale-socket race and
extension-registered providers remain known (`BACKLOG.md`), with no new runtime validation.
N1 (compaction logging) is implemented and not reopened.

## Completed

Two goals run through the implement → review → commit loop. Regression 78 → 81. No paid
calls, no push.

| Commit    | ID        | Result                                                              |
| --------- | --------- | ------------------------------------------------------------------- |
| `507cbd8` | V3        | A woken agent keeps its cwd before its first message.               |
| `ec2f95f` | V2        | Extensions that fail to load are logged.                            |
| `b7a830c` | P1, P3–P7 | Redundant checks and ignored arguments removed; no behavior change. |
| `fa60cd6` | V1        | Extensions get `session_shutdown` when an agent stops.              |

### V3. Waking a never-persisted session took the caller's cwd — `507cbd8`

- **Problem:** the SDK writes the session file only after the first message.
  `SessionManager.open(path)` on a missing file starts a new session in `process.cwd()`, so an
  agent spawned in A, stopped before any message and woken from B got a session in B while its
  services kept A (vega reproduced it with the real `SessionManager`).
- **Fix:** the runner passes the manifest cwd as `open`'s `cwdOverride`. A missing file is
  still legitimate and not rejected.
- **Verified:** the reviewer confirmed in the SDK that the override skips only `open`'s
  preliminary header scan; the full session (id, entries, migrations, parent) still loads.
  It does not rewrite an already persisted wrong `header.cwd`; pi-dock-created sessions never
  have one. Regression: spawn in A, stop, wake from B, first message, header cwd is A; fails
  without the fix. CHANGELOG Unreleased, Fixed.

### V2. Extension load errors were discarded — `ec2f95f`

- **Problem:** the SDK returns load and setup failures in `extensionsResult.errors` and never
  replays them into `onError`; the runner dropped them, so a broken extension vanished while
  `spawn`/`start` succeeded.
- **Fix:** each error logs `extension_error` with `on: load`, `extension: <path>` and the SDK's
  message as `reason`, no id; the agent carries on (owner decision C7). Logged after the
  manifest is written and before extensions bind: a create that fails (e.g. no model) logs
  `failed` without them, accepted as a narrow startup case. `services.diagnostics` is not
  logged (unknown `--x` flags are intentionally inert).
- **Verified:** regression with a real `.pi/extensions/broken.js` that throws on import:
  exactly one load `extension_error` before any work, and the agent still answers; fails
  without the fix. DESIGN, SKILL and CHANGELOG (Fixed) updated; the BACKLOG accepted limit now
  covers only errors during shutdown.

### P1, P3–P7. Clarity cleanup — `b7a830c`

- **P1:** `wake` no longer passes `thinking`/`flags`, which the runner reads from the manifest.
- **P3:** the runner trusts its startup gate (`startup` settles only with a session or with
  `terminal` set): `if (terminal)` alone, plain `session.`; `shutdown` keeps `session?.`.
- **P4:** `validateAgentName` keeps a single `typeof` (so `undefined` cannot pass as
  `"undefined"`) and drops what the regex guarantees (non-empty, lowercase).
- **P5:** `stateFromLog` is `event?.event === 'stopped' ? 'stopped' : 'failed'`.
- **P6:** `compact` prints `reply.error`; every refusal carries it.
- **P7:** `writeTempManifest` uses `dockDir()` and `fs.writeFile(tmp, body, { flag: 'wx' })`.
  The manifest-race test now creates the dock dir itself, as the runner does, since its
  workers bypass the runner. Only theoretical difference: a temp-name collision (PID + UUID)
  would now be cleaned up.
- **Verified:** reviewer checked each removed check against its guarantee; regression 80/80.
  No CHANGELOG entry.

### V1. `stop` never sent extensions `session_shutdown` — `fa60cd6`

- **Problem:** `shutdown` awaited `abort()` and called `session.dispose()`, which never emits
  `session_shutdown` (Pi's `AgentSessionRuntime.dispose()` does). Extensions skipped their
  cleanup; pi-link registers one. vega reproduced the missing dispatch with a real
  `ExtensionRunner`; no real data loss was reproduced.
- **Owner decisions:** (a) emit only for a shutdown that begins after `bindExtensions` has
  completed, on `stop` or a later failure; (b) await handlers without a cap, so a hanging one
  surfaces as `stop`'s `did not exit within 5s`; (c) handler errors during shutdown stay
  unlogged, so `stopped`/`failed` stays last (BACKLOG accepted limit).
- **Fix:** abort → `session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })`
  → dispose → terminal event. Eligibility is captured at shutdown entry from a `bound` flag set
  when `bindExtensions` resolves: the first version read it after `abort()`'s await, when a
  pending bind could still complete (found in review, round 2). No catch: the SDK catches a
  handler's error and passes it to `onError` listeners without a catch of its own; this
  runner's listener returns at once once `terminal` is set.
- **Verified:** regression with a real project extension whose handler records the log's last
  event: exactly `quit after spawned`, so it ran once, with reason quit, before `stopped`.
  Mutants (no emit, no `bound`, emit after `stopped`) fail it. The during-binding race has no
  test (not deterministic without hooks); the entry snapshot is checked in source. DESIGN,
  SKILL, README and CHANGELOG (Fixed) updated.
