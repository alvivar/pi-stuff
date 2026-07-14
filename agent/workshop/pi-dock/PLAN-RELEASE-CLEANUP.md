# pi-dock — pre-release cleanup plan

> **Status:** DECISIONS COMPLETE — ready for final ratification. **No implementation is authorized yet.**
> Q1–Q10 are resolved and recorded in §4. After context compaction, perform final plan/preflight review, create the run ledger, and obtain an explicit implementation go before dispatching code work.
>
> **Project:** `C:/Users/andre/.pi/agent/workshop/pi-dock/`
> **Repository root:** `C:/Users/andre/.pi/`
> **Publication copy (do not touch before the final release task):** `C:/AERO/me/code/pi-dock/`
> **Reviewed product baseline:** last commit touching pi-dock `04424af` (`chore(pi-dock): lock development dependencies`). The repository-wide HEAD observed by both reviewers was `60054e1`; intervening commits affected pi-link only, and `git diff --quiet 04424af -- agent/workshop/pi-dock` passed.
> **Last approved gates:** SDK `0.80.6`; syntax ×7; smoke `69/69`; Windows E2E of all 8 public commands approved at cumulative 8/8 provider operations. The pi-dock worktree was clean before this draft was created.
> **Review sources:** independent full-tree reviews and cross-reconciliation by Fable and Sol. Both read `bin/pi-dock.mjs`, all `src/*.mjs`, `test/smoke.mjs`, `package.json`, and relevant `PLAN.md` contracts.
> **Line numbers are approximate.** Re-locate by named functions and behavior anchors before editing.

## 1. Purpose and release bar

Fix the confirmed correctness, safety, lifecycle, and dead-axis findings before `0.1.0`, without broad refactoring or speculative cleanup.

The release bar is:

1. All accepted findings in §2 have an owner-ratified outcome.
2. Tasks T1–T5 are implemented **serially**, independently reviewed, gated LLM-free, and committed one at a time.
3. Sol approves each task and the integrated result. Per owner direction, Fable is outside the orchestrated cycle and may be invoked manually by the owner; Fable approval is not an automated pipeline gate.
4. Exactly one final full smoke is run only after integrated code approval, if the owner authorizes its two real model prompts.
5. T6 documentation and package preparation are approved before copying to the publication repository.
6. No runtime dependencies, build step, destructive agent command, or unrequested architecture is introduced.

## 2. Consolidated review findings

### 2.1 Confirmed release blockers

| ID | Location / anchor | Finding | Consensus |
|---|---|---|---|
| SOL-03 / FBL-C2 | `src/manifest.mjs`: `writeManifestFile`, `writeManifest`, `rewriteManifest` | Create uses `access(target)` followed by temp + `rename`; two creators can both observe absence, and a later loser can replace the winner's manifest. `wx` protects only the unique temp file. This can bind a durable name to the wrong session. The `flag` parameter is also a constant, false degree of freedom. | Release-blocker. |
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

**Recommended:** create `test/regression.mjs`, Node built-ins only, isolated temporary home/data, no SDK session/model/provider, no user registry/session mutation. It will accumulate focused tests across T1–T5 and run after every task.

Constraints:

- Fake pipes/helpers are owned children and must terminate cleanly.
- Scratch roots are collision-resistant and exhaustively removed.
- Never touch unrelated dock agents/sessions.
- Do not create a production abstraction solely for tests; a small log/timeout primitive is allowed only if it is the clearest production owner of a real invariant.
- Direct CLI subprocess fixtures are acceptable when isolated.

Questions:

1. Ratify one dedicated LLM-free test file?
2. Add an npm script such as `test:regression`, or invoke it directly? **Recommendation: direct invocation unless a public contributor workflow benefits from the script.**

**Owner decision:** use the simplest possible dedicated LLM-free regression test, invoked directly; do not add a test framework or npm-script layer unless implementation proves it materially simpler.

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

**Owner decision:** run-through, effective only after all remaining questions are resolved and the final plan receives an explicit implementation go. No current go is implied by this decision.

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
| Q7 regression organization | DECIDED — simplest dedicated direct LLM-free test | `Me gusta la idea del test más simple posible.` | T1 establishes one built-in-only file, no unnecessary layer. |
| Q8 review topology | DECIDED — Terra → Sol → committer; Fable manual/outside cycle | `Terra implementa, Sol hace review, committer sigue clásico, Fable queda fuera del ciclo (yo lo invoco manual).` | Bind roles exactly; no orchestrated Fable gate. |
| Q9 paid smoke | DECIDED — one final 2-prompt smoke after Sol approval; no fallback/retry | `Ok, sigo tu recomendación.` | Final paid gate authorized once. |
| Q10 autonomy | DECIDED — run-through after final explicit go | `Run-through` | One go after plan ratification; HOLD on listed exceptions. |

## 5. Proposed serial implementation tasks

These tasks are provisional until §4 is complete. No task may start from this draft alone.

### T1 — Exclusive manifest publication

**Where**

- `src/manifest.mjs`: `writeManifestFile`, `writeManifest`, `rewriteManifest`.
- New LLM-free regression harness from Q7.

**Problem**

Create checks and target publication are separate. A concurrent loser can replace the winner's durable identity/session mapping. The writer's `flag` parameter is constant and applies to the wrong object (the temp file rather than target install semantics).

**Required outcome**

- Create target publication is one exclusive atomic outcome: at most one winner.
- Losing creators cannot alter winner bytes and surface the existing public “agent already exists” contract.
- Readers never observe partial manifest JSON.
- Rewrite remains atomic replacement.
- Temp files are removed after success and every failure.
- Mechanism is not prescribed; it must be proven on Windows. If hard-link or another platform primitive is chosen, portability/fallback behavior must be declared as a material judgment for review.

**Risk:** high; sensitive durable-identity invariant.

**Verify**

- Sandboxed N-way concurrent creation: exactly one success, all others fail as existing, winner intact.
- Existing-target create cannot replace bytes.
- Rewrite replaces complete JSON atomically.
- Zero temp leftovers.
- No real user dock/session artifacts.

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
- Maximum two review-convergence iterations per task; sensitive disagreement escalates to the owner rather than using a tie-break.
- Every material deviation travels verbatim into review.
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
