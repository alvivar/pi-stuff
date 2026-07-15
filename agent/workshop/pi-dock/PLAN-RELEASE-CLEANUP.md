# pi-dock — pre-release cleanup plan

> **Status:** RATIFIED — execution authorized. The owner gave the explicit run-through go with `Go!` on 2026-07-14.
> Q1–Q10 are resolved and recorded in §4. The baseline passed 7/7 syntax checks with no product drift; execute the serial pipeline under §6 and HOLD only on its listed exceptions.
>
> **Project:** `C:/Users/andre/.pi/agent/workshop/pi-dock/`
> **Repository root:** `C:/Users/andre/.pi/`
> **Publication copy (do not touch before the final release task):** `C:/AERO/me/code/pi-dock/`
> **Reviewed product baseline:** last pre-plan commit touching pi-dock product/runtime/package files `04424af` (`chore(pi-dock): lock development dependencies`). Reviewers originally observed repository-wide HEAD `60054e1`; run preflight observed current HEAD `a76e0de` (`docs(pi-dock): plan pre-release cleanup`) and confirmed the only pi-dock delta from `04424af` was this plan, with no product/runtime/package drift.
> **Last approved gates:** SDK `0.80.6`; syntax ×7; smoke `69/69`; Windows E2E of all 8 public commands approved at cumulative 8/8 provider operations. The pi-dock worktree was clean before this draft was created.
> **Review sources:** independent full-tree reviews and cross-reconciliation by Fable and Sol. Both read `bin/pi-dock.mjs`, all `src/*.mjs`, `test/smoke.mjs`, `package.json`, and relevant `PLAN.md` contracts.
> **Line numbers are approximate.** Re-locate by named functions and behavior anchors before editing.

## 1. Purpose and release bar

Fix the confirmed correctness, safety, lifecycle, and dead-axis findings before `0.1.0`, without broad refactoring or speculative cleanup.

The release bar is:

1. All accepted findings in §2 have an owner-ratified outcome.
2. Tasks T1–T5 are implemented **serially**, independently reviewed, gated LLM-free, and committed one at a time.
3. Sol approves each task and the integrated result. Per owner direction, Fable is outside the orchestrated cycle and may be invoked manually by the owner; Fable approval is not an automated pipeline gate.
4. Exactly one final full smoke is run only after integrated code approval; Q9 records the owner's authorization for its two real model prompts and forbids fallback/retry.
5. T6 documentation and package preparation are approved before copying to the publication repository.
6. No runtime dependencies, build step, destructive agent command, or unrequested architecture is introduced.

## 2. Consolidated review findings

### 2.1 Confirmed release blockers

| ID | Location / anchor | Finding | Consensus |
|---|---|---|---|
| SOL-03 / FBL-C2 | `src/manifest.mjs`: `writeManifestFile`, `writeManifest`, `rewriteManifest`; concurrent `spawn` startup ownership | Create uses `access(target)` followed by temp + `rename`; two creators can both observe absence, and a later loser can replace the winner's manifest. `wx` protects only the unique temp file. This can bind a durable name to the wrong session. The `flag` parameter is also a constant, false degree of freedom. Mid-review, Sol proved that name-only parent handshake also lets a concurrent losing invocation report the winner as its own. | Release-blocker; fix both atomic publication and public invocation ownership under the owner-ratified T1 amendment. |
| SOL-02 | `src/paths.mjs` path/pipe derivation; every CLI name entry | Agent names are not validated. Separators such as `../x` can address files outside `~/.pi/dock`; whitespace/control/case/path syntax can break identity and output invariants. | Release-blocker. |
| SOL-04 / FBL-D1 / FBL-D1b | `bin/pi-dock.mjs`: `printLog`, `logsCommand` | Follow stores byte offsets but slices a UTF-16 string. Normal accented/emoji output shifts the offset and silently drops or garbles later records. It also emits torn fragments and advances past them, so completion can be printed as a second corrupt line. | Release-blocker. |
| SOL-01 | `bin/pi-dock.mjs`: `tryStatus`, `setCommand` | `tryStatus` swallows timeout and returns `null`; `set` therefore treats an unresponsive live pipe owner as powered off and rewrites the manifest, contradicting the powered-off-only mutation contract and the actionable timeout rule. | High and release-blocking. |

### 2.2 Confirmed correctness work

| ID | Location / anchor | Finding | Consensus |
|---|---|---|---|
| SOL-05 | `src/budget.mjs`: `parseBudget`; `src/runner.mjs`: `startBudgetTimer` | Any finite positive minutes value is accepted, but values above Node's timer ceiling (~35,791.39 minutes) overflow `setTimeout` and fire almost immediately. | Medium; fix before release or explicitly ratify a bounded grammar. |
| SOL-06 | `bin/pi-dock.mjs`: `lastCompleteLogEvent`, `stateFromLog` | If the file does not end in `\n`, the implementation returns `null` and discards all preceding complete state. `PLAN.md` Decision #3 says only the torn last line is ignored. | Medium; default recommendation is to make code honor the existing contract. |

### 2.3 Confirmed dead-axis cleanup

| ID | Location / anchor | Finding | Required disposition |
|---|---|---|---|
| FBL-C1 + SOL-08 | `src/runner.mjs`: `findModel` and sole caller | The `!spec` guard is unreachable because the caller checks first; the function is also `async` without `await`. | Resolve together: one clear optional-model boundary, synchronous lookup, same errors and legacy behavior. |
| FBL-C2 | `src/manifest.mjs`: writer helper | `flag` is always `'wx'` and does not express target create-vs-rewrite semantics. | Fold into SOL-03; do not make a standalone cleanup. |
| FBL-C3 | `bin/pi-dock.mjs`: `sdkPromise`, `loadSdk`, `preflightSpawn` | One CLI invocation can preflight at most once, so the explicit promise cache cannot be reused. Lazy import itself is justified. | Preserve lazy dynamic import; remove only the dead cache/wrapper axis. |

### 2.4 Documentation obligations for T6

- **Headless trust warning — required and release-blocking if omitted.** The runner loads project configuration/resources from `<cwd>/.pi`, including configured extensions, without Pi's interactive project-trust prompt. README must say that starting an agent treats its working directory as trusted and that pi-dock should be used only in trusted directories.
- **Dependency-lock honesty.** `package-lock.json` reproduces contributor/CI installs for this checkout; it does not pin all transitives for npm consumers. The official SDK `0.80.6` shrinkwrap facts (three nested official records without their own outer-lock `integrity`; two normal nested install scripts) are release-audit evidence, not product defects. Do not claim “all consumer transitives are integrity-pinned” or “no install scripts.” Do not dump normal vendor internals into README/CHANGELOG unless the owner explicitly chooses to.
- Preserve platform honesty: Windows lifecycle/E2E verified; Unix inspected but not runtime-tested.

### 2.5 Explicitly deferred or rejected before 0.1.0

Do not change these unless new evidence or an owner decision amends this plan:

- Parallelizing `ls` status probes (SOL-07): unmeasured and low priority.
- Broad command-dispatch, pipe, logging, SDK-service, or manifest-schema refactors.
- Replacing `appendFileSync`; ordered low-volume durable events justify it.
- `thinkingOption` inlining (FBL-N2): the named translation is defensible.
- Removing the explicit budget parameter from `subscribeToSession` (FBL-N3): it documents the immutable dependency.
- Generalizing `send` and `compact`; their semantics differ.
- Cosmetic accepted residuals: compact/stop completion ordering, validation precedence, empty `--budget=` rendering, internal missing-`--name` exit style.
- A project-trust feature redesign. Document the headless behavior for 0.1.0; changing extension/resource loading is separate product design.
- A performance-only rewrite of follow. The implementation may read only appended bytes if that is the simplest correct state model, but the required contract is correctness, not an O(f²) optimization project.

## 3. Questions to resolve before ratification

Record answers in §4. Questions should be discussed in order because later task briefs depend on them.

### Q1 — Portable agent-name grammar

**Recommended policy:** lowercase portable identities, maximum 64 characters:

```regex
^[a-z0-9]+(?:[._-][a-z0-9]+)*$
```

Recommended exact error:

```text
invalid agent name: <value>
```

This accepts all currently observed names (`haiku1`–`haiku4`, `dockcheck-202610`) and documented/smoke naming shapes, while rejecting separators, whitespace, controls, leading/trailing punctuation, repeated punctuation segments, uppercase collision ambiguity on Windows, and impractical socket names.

Questions:

1. Ratify this grammar and maximum?
2. Should uppercase input be rejected, or normalized to lowercase? **Recommendation: reject**; silent normalization can target an existing identity unexpectedly.
3. Are Unicode display names required for 0.1.0? **Recommendation: no**; keep the durable identity portable and consider a separate display label later.
4. Must any additional real registry names be inventoried before ratification?
5. Should invalid names be rejected identically by all public commands before any path or pipe access? **Recommendation: yes.**

**Owner decision:** use the recommended lowercase portable grammar with maximum 64 characters; reject rather than normalize uppercase; do not support Unicode identity names in 0.1.0; reject Windows reserved device basenames (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, case-insensitively); reject identically before every path/pipe access. This deliberately avoids a new hashed Unix pipe-path design: simpler is better.

### Q2 — Long numeric budget policy

Current grammar accepts any finite positive numeric minutes, but Node timers support only about 35,791.39 minutes per scheduled delay.

**Option A — bounded numeric grammar (recommended):**

- Accept numeric minutes up to `35791`.
- Reject larger values as `invalid budget: <value>` everywhere, including legacy manifest wake.
- Keep literal `off` as the explicit unlimited mode.
- Update help and README.
- Advantages: simple implementation, deterministic boundary tests, no timer abstraction.
- Cost: material amendment to the previously ratified “positive numeric minutes” grammar; a hypothetical stored larger budget becomes invalid.

**Option B — chained timer scheduling:**

- Preserve every finite positive minutes value.
- Schedule bounded chunks until the total duration is exhausted.
- Must handle multiplication overflow/very large finite values without near-immediate failure.
- Requires a justified testable scheduling seam or equivalent deterministic tests.
- Advantages: no grammar change.
- Cost: more lifecycle state and tests for a use case already represented more clearly by `off`.

Questions:

1. Choose Option A or B.
2. If A, ratify `35791` and `off` as unlimited.
3. If B, is the extra scheduler complexity justified under the “every line justified” rule?

**Owner decision:** Option A. Maximum numeric minutes `35791`; literal `off` remains unlimited; larger numeric values are invalid consistently in CLI and manifest validation. No strong disadvantage was identified beyond the explicitly accepted grammar amendment and hypothetical incompatibility with stored values above the cap (none observed).

### Q3 — Torn terminal log semantics

Existing ratified contract: ignore only the torn final fragment and derive state from the previous complete event.

A defensible alternative is conservative failure: a fragment after `stopped` may indicate a later process died while appending, so report `failed`.

**Owner decision:** keep the existing contract and fix the code. Ignore only the torn final fragment and derive from the previous complete event: `stopped\n<torn>` → `stopped`; `failed\n<torn>` → `failed`; `idle\n<torn>` → `failed`. Do not amend the contract to conservative failure.

### Q4 — Follow implementation boundary

Both reviewers agree on the required behavior but differ on whether appended-only I/O should be mandatory.

Required outcome regardless of mechanism:

1. Offsets are bytes end-to-end.
2. Only complete newline-delimited records advance the committed offset.
3. Trailing incomplete bytes survive until the next poll.
4. UTF-8 decode occurs only after a complete line is assembled.
5. Each complete event is emitted once, in order, without corruption.
6. No growth emits nothing.

**Owner decision:** choose the simplest whole-file mechanism. Each follow poll reads the complete file as a `Buffer`, slices using a committed byte offset, processes only through the last complete newline, and advances only through those complete bytes. A torn suffix remains uncommitted for the next poll. Do not introduce appended-only reads, persistent descriptors, stream state, or a performance refactor. Document this deliberate simplicity in implementation/review and preserve the outcome tests above.

### Q5 — Task order: identity boundary first or last

Reviewers agreed tasks must be serial but proposed two reasonable orders:

- **Name first:** establishes valid fixture and path boundaries early.
- **Name last:** it is the broadest CLI surface; doing focused manifest/runner/log/set tasks first reduces shared-file review risk.

**Owner decision:** ratify the recommended order: manifest → runner/budget → logs → set → names → integrated gate/docs/release. All test fixtures use known-valid names, and the broadest CLI change lands after focused regions are stable.

### Q6 — Optional micro-cleanups

Candidates:

- FBL-N1: hoist duplicated `pending -= 1`; both branches currently decrement exactly once.
- FBL-N4: parenthesize mixed `||` / `&&` in budget validation.

N2/N3 are explicitly rejected in §2.5.

**Owner decision:** include FBL-N1 and FBL-N4 only as riders in T2. Hoist the duplicated `pending -= 1` without changing queue/shutdown snapshot behavior; parenthesize the mixed budget condition without changing precedence. Exclude N2 and N3: their helpers/dependencies remain justified. No standalone micro-cleanup commit.

### Q7 — Regression-test organization

**Recommended:** create `test/regression.mjs`, Node built-ins only, isolated temporary home/data, no model/provider/prompt and no user registry/session mutation. It will accumulate focused tests across T1–T5 and run after every task. The owner later ratified one narrow T1 exception: the sandboxed concurrency case may launch the real runner and therefore import the official SDK/create disposable sessions, but it must use an empty trusted scratch cwd, perform zero provider operations, and remove every owned artifact/process.

Constraints:

- Fake pipes/helpers are owned children and must terminate cleanly.
- Scratch roots are collision-resistant and exhaustively removed.
- Never touch unrelated dock agents/sessions.
- Do not create a production abstraction solely for tests; a small log/timeout primitive is allowed only if it is the clearest production owner of a real invariant.
- Direct CLI subprocess fixtures are acceptable when isolated.

Questions:

1. Ratify one dedicated LLM-free test file?
2. Add an npm script such as `test:regression`, or invoke it directly? **Recommendation: direct invocation unless a public contributor workflow benefits from the script.**

**Owner decision:** use the simplest possible dedicated LLM-free regression test, invoked directly; do not add a test framework or npm-script layer. Under the later Fable design ratification, prefer a real isolated runner race over a mirrored startup protocol: SDK import/disposable sandbox sessions are allowed only for that T1 case, with zero model prompts/provider operations and exhaustive cleanup. The owner subsequently authorized explicit SDK isolation option A: override `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` to owned paths under the sandbox and set `PI_OFFLINE=1`; inherited host overrides must never escape the sandbox.

### Q8 — Review topology

Options:

- One primary reviewer after every task, then both Fable and Sol review the integrated result serially.
- Alternate Fable/Sol per task, then one final integrated reviewer.

**Owner decision:** Terra implements; Sol is the sole orchestrated code reviewer for every task and the integrated result; the dedicated committer keeps the classic scope/hygiene role. Fable stays outside the orchestrated cycle and may be invoked manually by the owner. Do not contact Fable as a pipeline gate.

### Q9 — Paid final smoke

Per-task convergence can be fully LLM-free. The existing smoke makes exactly two real model prompts.

**Owner decision:** after all code tasks and Sol's integrated review approve, run exactly one final `node test/smoke.mjs` using the already-proven configured default: exactly 2 real prompts, no fallback and no automatic retry. Any red product or environmental result stops immediately as BLOCKED after cleanup; another run requires new owner authorization.

### Q10 — Autonomy

- **Run-through:** one owner go covers T1–T6; HOLD on material deviation, red gate, review deadlock, paid-gate failure, or scope change.
- **Gate-per-task:** owner approves before every commit.

**Owner decision:** run-through, effective only after all remaining questions are resolved and the final plan receives an explicit implementation go. The decision itself implied no go; the owner subsequently activated it with `Go!` on 2026-07-14.

### T1 mid-review amendment — concurrent public spawn ownership

Sol proved that atomic manifest publication alone cannot preserve the ratified public loser error: concurrent parent CLIs handshake only by shared name and can both report the one winner as `idle`, even with different requested configuration. The owner chose the ownership-aware option with `Ok, me parece bien esta recomendación.`

**Ratified outcome:** for simultaneous successful same-name create attempts, exactly one invocation may report success, and that success must belong to the runner/configuration launched by that invocation; every publication loser returns exact `agent already exists: <name>` with exit 1. An expected publication loss must not append `failed` to the winner's shared log or bind/wake the winner while pretending to own creation. Preserve ordinary wake/start behavior and truthful crash/timeout failures.

After two rejected stdout-ack review iterations, the owner ratified Fable's simpler design with `Estoy de acuerdo con el diseño de Fable.` Delete the private stdout/token protocol entirely. Keep explicit boolean create intent; retain the launched `child.pid`; use the existing name/pipe handshake; add the serving runner's `process.pid` to the additive status reply; succeed and print the real returned state only when `status.pid === child.pid`; PID mismatch is exact public already-exists. Expected manifest losers dispose/exit silently before catch-all failure logging. Do not add stdout/IPC channels, tokens, a new protocol module, log archaeology, or reservation/stale-lock state.

This design accepts the already-ratified pre-publication loser SDK/session/extension residual and negligible live-window PID-reuse risk. Winner crash after manifest publication but before listening retains truthful baseline handshake-failure behavior. The T1 regression may launch real runners in a fully isolated sandbox despite Q7's original no-SDK wording; it must send zero prompts/provider operations and clean all sessions, pipes, children, logs, and registry files. The owner authorized one pinned T1 rework implementation pass and one fresh Sol review beyond the prior iteration cap. That review approved production and found only bounded harness defects; the owner then authorized one final test-only cleanup plus Sol verification. Production must not reopen; any further issue returns to HOLD.

## 4. Owner decision log

Fill this section during point-by-point analysis. A decision is not ratified until it includes the owner's wording/date and any rationale that reviewers must receive.

| Question | Decision | Owner wording/date | Consequence for task brief |
|---|---|---|---|
| Q1 name grammar | DECIDED — lowercase portable regex, max 64, reject uppercase/Unicode/reserved Windows basenames, uniform pre-path rejection | `Que sea 64! Más simple mejor.` plus prior agreement with the remaining policy. | T5 stays small; no hashed Unix pipe design. |
| Q2 long budgets | DECIDED — cap numeric minutes at 35791; `off` unlimited | `Estoy feliz con el máximo numérico a menos que encuentres un problema o una desventaja fuerte con esto.` No strong disadvantage found. | T2 validates cap consistently and updates help/docs. |
| Q3 torn state | DECIDED — preserve contract; ignore only torn suffix and derive from prior complete event | `Estoy de acuerdo.` after the explicit Q3 recommendation. | T3 state matrix pinned. |
| Q4 follow mechanism freedom | DECIDED — whole-file Buffer, byte offset, commit through last newline only; no appended-only optimization | `La opción más simple, el archivo completo, documenta este punto para luego.` | T3 mechanism and tests pinned. |
| Q5 task order | DECIDED — manifest → runner/budget → logs → set → names → integration/docs | `Estoy de acuerdo.` after the explicit Q5 recommendation. | Final serial sequence pinned. |
| Q6 micro-cleanups | DECIDED — include N1/N4 as T2 riders; exclude N2/N3 | `De acuerdo con lo que acabas de decir.` | T2 exact cleanup scope pinned. |
| Q7 regression organization | DECIDED — simplest dedicated direct LLM-free test; narrow real-runner SDK/sandbox exception for T1, zero prompts/provider | `Me gusta la idea del test más simple posible.` and later `Estoy de acuerdo con el diseño de Fable.` | Use production runner race, not mirrored protocol or test-only abstraction; exhaustive owned cleanup. |
| Q8 review topology | DECIDED — Terra → Sol → committer; Fable manual/outside cycle | `Terra implementa, Sol hace review, committer sigue clásico, Fable queda fuera del ciclo (yo lo invoco manual).` | Bind roles exactly; no orchestrated Fable gate. |
| Q9 paid smoke | DECIDED — one final 2-prompt smoke after Sol approval; no fallback/retry | `Ok, sigo tu recomendación.` | Final paid gate authorized once. |
| Q10 autonomy | DECIDED — run-through after final explicit go | `Run-through` | One go after plan ratification; HOLD on listed exceptions. |
| T1 concurrent spawn ownership | DECIDED — delete stdout/token; boolean create intent + additive status PID + launched child PID comparison over baseline handshake; silent loser; real state | `Estoy de acuerdo con el diseño de Fable.` after manual fresh-eyes advice. | One pinned rework + one Sol review authorized beyond old cap; no new protocol/module/reservation. |
| Global replacement hygiene | DECIDED — chosen implementation replaces rejected/intermediate designs completely; no dead shims, parallel paths, stale helpers/imports/tests, or speculative compatibility | `No me interesa backward compatibility, o arrastrar cosas sin terminar. La implementación que se decide se crea y se eliminan las sobras innecesarias. No arrastramos basura.` | Enforce deletion in implementation/review. Explicit previously ratified compatibility contracts require a separate owner amendment rather than silent removal. |
| T1 final harness isolation/cleanup | DECIDED — explicit owned SDK/session dirs + offline; clear losing timers; sandbox removal survives child-cleanup errors; loser exit 0 asserted | `Estoy de acuerdo con 2 y 3...` then `Autorizo A.` after item 1 explanation. | One final `test/regression.mjs`-only correction and Sol verification; production frozen. |

## 5. Proposed serial implementation tasks

These tasks are ratified by the owner and execute serially under the run-through go recorded above.

### T1 — Exclusive manifest publication

**Where**

- `src/manifest.mjs`: `writeManifestFile`, `writeManifest`, `rewriteManifest`.
- `bin/pi-dock.mjs`: create-only `spawnCommand` / `launchRunner` ownership check reusing the existing `handshake` unchanged in lifecycle.
- `src/runner.mjs`: boolean create intent, expected publication-loss handling, and additive PID in existing status; do not alter ordinary wake/start semantics.
- New LLM-free regression harness from Q7.

**Problem**

Create checks and target publication are separate. A concurrent loser can replace the winner's durable identity/session mapping. The writer's `flag` parameter is constant and applies to the wrong object (the temp file rather than target install semantics).

Additionally, parent CLIs currently handshake by shared name rather than launched-runner ownership. After atomic publication, a losing same-name invocation can handshake with the winner and falsely report success for configuration it did not create; the losing runner can also append `failed` to the winner's name-derived log.

**Required outcome**

- Create target publication is one exclusive atomic outcome: at most one winner.
- Losing creators cannot alter winner bytes. For simultaneous successful same-name create attempts, exactly one parent reports success for its own launched runner/configuration; every loser returns exact `agent already exists: <name>` with exit 1.
- An expected publication loser does not append `failed` to the winner's shared log, wake/bind the winner as if it owned creation, or otherwise contaminate the winner's terminal state.
- Readers never observe partial manifest JSON.
- Rewrite remains atomic replacement.
- Temp cleanup is ownership-safe: never delete an unacquired collision, never roll back a winner, and never let cleanup failure replace the primary publication/rewrite success or error.
- Manifest publication remains the approved same-directory hard-link/no-unsafe-fallback mechanism proven on Windows.
- Startup ownership uses only the ratified simple mechanism: boolean create intent; `launchRunner` returns its child/PID with ignored stdio as baseline; existing handshake returns actual status including additive `pid`; exact PID match succeeds/prints real state, mismatch returns public already-exists. Delete token/randomUUID/private stdout/waiter/timer/parser plumbing.
- Preserve ordinary wake/start, configuration precedence, truthful crash/timeout behavior, and existing pre-existing-agent errors. Do not add stdout/IPC protocol, new module, log-PID lookup, or early reservation/stale-lock subsystem.

**Risk:** high; sensitive durable-identity and create-startup ownership invariant. Serialize the expanded `bin`/runner region before later T2–T5 work.

**Verify**

- Sandboxed N-way concurrent manifest creation: exactly one internal winner, all others fail as existing, winner intact.
- Real-runner N-way create-intent race under isolated HOME/USERPROFILE and empty trusted scratch cwd: exactly one pipe owner; status PID matches exactly one launched child; one spawned log event with that PID; manifest/configuration belong to that winner; losers exit silently with no shared `failed` and each closes with exit code 0; all owned children/sessions/pipes/files cleaned.
- Override `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` to explicit owned sandbox paths and set `PI_OFFLINE=1`; never inherit a host SDK path outside the scratch root.
- Every child-wait timeout is cleared when close wins. Child cleanup is best-effort for all owned children, but exact sandbox removal is attempted in a guaranteed final path; preserve/report cleanup errors after attempting both.
- The real-runner case may import SDK/create sandbox sessions but performs zero model/provider/prompt operations. Do not mirror parent/runner protocol or fabricate public results.
- Parent PID comparison is small eyes-on production logic and is also covered by the one reserved final smoke's ordinary spawn; do not import user credentials into regression.
- Cover create intent so a publication loser cannot become a wake runner and falsely satisfy ownership; reason through truthful winner crash-before-listen/timeout behavior without false success.
- Existing-target create cannot replace bytes.
- Rewrite replaces complete JSON atomically.
- Ownership-safe cleanup; zero normal-path temp leftovers; primary outcome/error preservation reasoned or deterministically tested without adding a production-only mocking architecture.
- Declare whether loser-side SDK session/extension initialization can still occur; an early reservation/stale-lock subsystem is out of scope absent a new HOLD.
- No provider or real user dock/session artifacts.

### T2 — Long-budget correctness and model lookup boundary

**Where**

- `src/budget.mjs`: parser/validation if Q2 chooses a maximum.
- `src/runner.mjs`: `startBudgetTimer`, `findModel`, sole caller.
- Regression harness.

**Problem**

Large accepted minute values overflow Node timers. Model lookup has a redundant caller/guard axis and unnecessary async boundary.

**Required outcome**

- Implement the ratified Q2 policy consistently in CLI validation, powered-off `set`, manifest wake validation, timer behavior, help, and later README.
- No accepted numeric budget fails near-immediately because of timer overflow.
- `off` remains unlimited.
- `findModel` becomes a single synchronous optional-model boundary with unchanged qualification/error semantics.
- Legacy manifests without dedicated `model` continue to wake according to the approved compatibility rules.
- Hoist the duplicated `pending -= 1` exactly once per queued prompt without changing shutdown snapshot semantics.
- Parenthesize the mixed budget-validation condition without changing behavior.
- Do not change thinking-level semantics or prompt budget reset rules; do not inline `thinkingOption` or hide the subscription's explicit budget dependency.

**Risk:** medium; runner lifecycle and ratified grammar.

**Verify**

- Boundary matrix below/at/above chosen maximum, or deterministic chunk-scheduling tests.
- Malformed budget grammar remains rejected exactly as before.
- Legacy missing-model path preserves behavior.
- No provider call.

### T3 — Complete-record and UTF-8 log correctness

**Where**

- `bin/pi-dock.mjs`: `printLog`, `logsCommand`, `lastCompleteLogEvent`, `stateFromLog`.
- Regression harness.

**Problem**

Follow mixes byte and UTF-16 units, commits torn fragments, and can skip/duplicate output. State derivation discards complete events when a torn suffix exists.

**Required outcome**

- Preserve the ratified torn-state contract: ignore only the final incomplete fragment and derive from the prior complete event (`stopped`/`failed`; any nonterminal or absent complete event → `failed`).
- Implement the ratified Q4 whole-file-Buffer mechanism: committed offset and slicing are bytes; emit/advance only through the last complete newline; leave a torn suffix uncommitted for the next poll.
- Preserve one-shot `logs` diagnostics unless a behavior change is explicitly justified and reviewed.
- Preserve `formatLogLine` output for valid complete events.
- Do not conflate human diagnostics with terminal-state derivation.

**Risk:** high; primary detached-output surface and durable status semantics. Serialize all edits to this `bin` region.

**Verify**

- Accented and emoji event followed by later event: later event exactly once, uncorrupted.
- One event physically split inside a multibyte code point: no output before newline completion; one valid formatted event after completion.
- Multiple appended events preserve order and uniqueness.
- No-growth poll emits nothing.
- State fixture matrix: complete stopped; stopped + torn; idle + torn; only torn; empty; missing, according to Q3.
- No AgentSession or provider.

### T4 — Powered-off-only `set` and lazy SDK cleanup

**Where**

- `bin/pi-dock.mjs`: `tryStatus` or a mutation-specific replacement, `setCommand`, `sdkPromise`, `loadSdk`, `preflightSpawn`.
- Regression harness.

**Problem**

Mutation collapses timeout/unresponsive into absence. SDK lazy import has a cache lifetime axis that cannot be reused.

**Required outcome**

- Positive status → exact running refusal.
- Definitely absent pipe → mutation may proceed.
- Timeout/unresponsive → exact `agent <name> is not responding`, exit 1, manifest byte-identical.
- Unknown/non-absence transport failures fail closed; they must not authorize mutation.
- Preserve lazy SDK import and cheap validation/missing-agent behavior before import.
- Remove only the dead cache/wrapper axis; no broad dispatch rewrite.

**Risk:** high; mutable identity/liveness boundary. Serialize against T3/T5 because they share `bin/pi-dock.mjs`.

**Verify**

- Owned fake pipe accepts but never replies; `set` returns exact timeout error and manifest bytes do not change.
- Dead pipe set succeeds.
- Responsive live pipe gets exact running refusal.
- Invalid thinking/budget and missing agent remain cheap/SDK-free where currently guaranteed.
- Helper and pipe cleanup exhaustive; no external PID kill without exact command-line ownership proof.

### T5 — Portable agent-name boundary

**Where**

- Central validation owner, likely near `src/paths.mjs` path/pipe derivation.
- `bin/pi-dock.mjs` public entry points/choke points as required.
- Regression harness.

**Problem**

Raw names can escape the state root or create ambiguous, nonportable identities.

**Required outcome**

- Implement exact Q1 policy before any path or pipe access: `^[a-z0-9]+(?:[._-][a-z0-9]+)*$`, maximum 64 characters, plus case-insensitive rejection of Windows reserved device basenames.
- Reject uppercase and Unicode rather than normalize; use exact `invalid agent name: <value>`.
- All eight public commands enforce the same identity rule where a name is accepted.
- Existing valid manifests still list and operate.
- Invalid names produce zero registry/session/pipe/out-of-root mutation.
- Do not silently normalize unless Q1 explicitly chooses it.

**Risk:** high; broad input boundary. Place last among code tasks under recommended Q5 sequencing.

**Verify**

- Accept every existing/documented valid shape.
- Reject traversal (`../x`, `..\\x`), both slash forms, empty, whitespace/control, uppercase or Unicode according to Q1, leading/trailing/repeated punctuation according to Q1, and over-length values.
- Sentinel files both inside and outside sandbox remain unchanged for every rejection.
- Windows case/path and pipe behavior verified.

### T6 — Integrated gate, release docs, and publication-package preparation

**Code integration gate before docs**

1. Full syntax gate in §6.
2. Full LLM-free regression suite.
3. Integrated review by Sol, routed through the orchestrator.
4. LLM-free convergence only, bounded by the pipeline policy.
5. Fable is outside the orchestrated cycle; any manual owner-requested Fable review is informational unless the owner explicitly amends the plan.
6. Run the Q9-authorized final full smoke exactly once with exactly two provider prompts, no fallback, and no automatic retry.

**Documentation/package scope**

- Complete README: install, all 8 commands, resident lifecycle, durable session/memory association, model/thinking/budget rules, opaque repeatable `--x`, pi-link use, compact semantics, crash/budget/wedge recovery, PID ownership warning, support/platform honesty, and headless trust warning.
- Create/update CHANGELOG for `0.1.0` without vendor-internal noise.
- Explain lock scope only if dependencies/reproducibility are discussed; make no consumer-transitive guarantee.
- Confirm package metadata, files, license, bin, no runtime dependency drift, and version `0.1.0`.
- Run `npm pack --dry-run` and inspect the exact file list; no publish.
- Independently review docs/package.
- Commit approved release docs/package changes.
- Copy only the tested publication package to `C:/AERO/me/code/pi-dock/`; compare contents against the approved source/package manifest.
- Owner alone performs `npm login` and `npm publish`; verify published `pi-dock@0.1.0` afterward.

**Risk:** medium; public contract and publication contents.

## 6. Gates and orchestration contract

### Per-task LLM-free gate

Run after every T1–T5 implementation and convergence iteration:

```text
node --check bin/pi-dock.mjs
node --check src/budget.mjs
node --check src/manifest.mjs
node --check src/paths.mjs
node --check src/pipe.mjs
node --check src/runner.mjs
node --check test/smoke.mjs
node --check test/regression.mjs
node test/regression.mjs
git diff --check
git status --short
```

Adjust only if Q7 chooses another test filename. No command above may invoke a provider.

### Paid gate

```text
node test/smoke.mjs
```

- Run at most once, only after Sol's integrated code approval; Q9 authorization is recorded.
- Expected: current 69 checks plus any deliberately added smoke-only checks; exactly two real prompts.
- No retry, fallback model, or second run without new owner authorization.

### Pipeline

- Orchestrator writes plan/ledger and routes work; never edits/reviews product code or commits.
- Implementer edits and self-runs the gate.
- Reviewer differs from implementer.
- Dedicated committer verifies scope/hygiene and commits only after approval; never re-reviews correctness.
- Commit each task before the next implementation so diffs stay task-scoped.
- Shared `bin/pi-dock.mjs` and `test/regression.mjs` edits are strictly serial.
- Maximum two review-convergence iterations per task; sensitive disagreement escalates to the owner rather than using a tie-break. T1 exhausted that cap and escalated; the owner explicitly authorized one pinned Fable-design rework plus one fresh Sol review. Sol approved production and found only harness isolation/cleanup defects; the owner explicitly authorized one final `test/regression.mjs`-only correction plus Sol verification. No production change or further T1 convergence is implicit.
- Every material deviation travels verbatim into review.
- Replacement hygiene is mandatory: when a design supersedes an intermediate/rejected design, delete the old path, helpers, imports, state, fixtures, and comments completely. Do not add compatibility shims or parallel implementations unless the owner explicitly ratifies that compatibility. Previously ratified compatibility requirements (notably T2 legacy missing-`model` wake behavior) remain contracts until separately amended; do not silently reinterpret them.
- Reassess worker context at every IMPLEMENT/REVIEW/COMMIT boundary; compact only at task boundaries, never mid-task.
- Scratch resources are collision-resistant and exhaustively removed. Never touch unrelated dock agents, sessions, pipes, settings, processes, or link identities.

## 7. Definition of done

This cleanup plan is complete only when:

- §4 contains owner decisions for Q1–Q10.
- The owner explicitly ratifies the final plan and autonomy level.
- T1–T5 each have a scoped approved commit and green LLM-free gate.
- Sol approves every task and the integrated code; Fable remains outside the orchestrated cycle unless the owner amends this decision.
- The Q9-authorized final smoke is green with exactly two prompts.
- T6 docs/package are independently approved and committed.
- Publication repo is an exact copy of the tested package.
- Workshop worktree is clean and run-state plan/ledger/report artifacts are disposed after the final summary.
- `npm publish` remains an explicit owner action.
