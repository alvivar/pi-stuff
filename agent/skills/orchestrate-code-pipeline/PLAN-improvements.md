# PLAN — orchestrate-code-pipeline skill improvements

Improve the experimental orchestration skill (SKILL.md + templates/) based on a
four-way review (2026-06-11): fable (author of this plan; was the _implementer_
in the live archon run), opus@pi-link (also lived the run), gpt@pi-link, and
committer@.pi (the role the pipeline's COMMIT state dispatches to). All 9
original findings received unanimous AGREE; reviewers added 8 more, all
consolidated below with attribution.

Doc-only. No pi-link core changes. The skill is experimental and unpackaged —
no version/CHANGELOG concerns.

## Decisions (defaults adopted by reviewer consensus — owner may veto)

- **Compaction threshold: 70%** of the worker's context window, predictive
  (`current + estimated_task_cost`). Endorsed by opus (consistent with
  pre-empting auto-compaction) and gpt ("conservative, good enough").
- **Task-cost heuristics (labeled rough):** small fix 10–20K · medium task
  40–80K · review 20–40K. opus's real-run data brackets these (small refactor
  ≈10–20K, sensitive pass ≈25K).
- **Review iteration cap: 2**, then implementer tie-break (§3.7). opus: "our
  run needed ≤1; 2 is generous without enabling ping-pong."
- **v1 is serial-only** (opus recommendation): declare it; move safe-parallel
  rules to a future-work note rather than half-permitting parallelism.
- **Ledger lives next to the plan** (`LEDGER-<plan>.md`); disposed per the
  delete-after-done convention at run end.

---

## A. SKILL.md findings

### A1 — Reference companion skill by name, not path (fable #1; unanimous)

The hardcoded `C:/Users/andre/.pi/agent/npm/node_modules/...` path is
user/machine-specific and breaks on relocation. opus adds: two copies of
pi-link-coordination exist on this machine (installed + workshop), so a path
also picks the wrong copy ambiguously. **Fix:** "load the
`pi-link-coordination` skill (listed in your available skills)" — the harness
resolves location.

### A2 — Make THRESHOLD and "bounded" executable (fable #3; unanimous)

§2 pre-flight names an undefined THRESHOLD; §3.7 says "bounded" with no bound.
**Fix:** insert the adopted defaults (70%, cost bands, cap 2) at those points.
gpt's two riders, both adopted:

- **Unknown context (`?/limit`) is unknown, not safe** — if a worker doesn't
  report context, don't assume room; compact before large/sensitive work.
- **Compact idle targets only** (busy targets decline anyway; don't queue on a
  mid-task worker).

### A3 — Pre-flight guards every dispatch, not just IMPLEMENT (opus A)

§2 runs the context check once, before the implementer. Reviewer and committer
also grow over a long run. **Fix:** the PRE-FLIGHT line applies before _each_
dispatch, any role; reword §3.4 to "any worker (the implementer grows
fastest)".

### A3b — State the _why_ of predictive compaction (opus C)

§3.4 gives the rule but not the hazard, and rationale is what makes agents
actually obey. **Fix:** add one clause to §3.4: the danger is not a full
window per se — it's Pi's **auto-compaction firing mid-task**, which can shed
the dispatch brief's details at the worst moment; orchestrated compaction
while idle exists to pre-empt that.

### A4 — Add the BLOCKED arc to the state machine (opus B)

GATE defines red==BLOCKED and §5 diagnoses it, but §2 has no transition.
**Fix:** add `BLOCKED → relay failure details → re-IMPLEMENT (bounded, same
cap as CONVERGE, then escalate to user)` to the loop pseudocode.

### A5 — Operationalize WAIT + name the Golden Rule exception (fable #4; unanimous)

**Fix:** in §2/§4: "WAIT means end your turn — the callback _is_ your next
turn. Do not poll, sleep, or busy-loop `link_list`." And in §5 row 1: label the
status `link_prompt` as **the only sanctioned Golden Rule exception**, allowed
only after `link_list` confirms the worker idle with no callback received.
(opus confirms this exact recovery was needed in the live run.)

### A6 — State why commit-per-task is load-bearing (fable #5; unanimous)

Review reads the _uncommitted_ diff (`git diff -- <file>`); committing each
task is what keeps the reviewer's diff single-task. **Fix:** one sentence in
§2 (at COMMIT) or §3: "Commit before the next IMPLEMENT — deferring/batching
commits blurs every subsequent review diff." opus supplies the mechanism
wording; the live run's per-task hashes prove the happy path.

### A7 — Agree the autonomy level at pre-flight (fable #6; unanimous)

Run-through under one global go vs. user gate per task — the live run was
effectively gate-per-task but nothing recorded that. **Fix:** pre-flight step
4 asks the user which mode; ledger gets an `Autonomy:` field.

### A8 — Run-end state + ledger lifecycle (fable #7 + opus; unanimous)

The loop just stops. **Fix:** add §8 (run end): final summary to the user
(tasks/commits/gates/dissents), ledger closed and disposed per the
delete-after-done convention. State the ledger's location (next to the plan)
in §0/§6.

### A9 — Declare v1 serial-only (fable #8, opus recommendation; unanimous)

§7's "don't over-parallelize" half-permits what §2 can't express. **Fix:**
declare the pipeline serial-only; add a short future-work note capturing
gpt's safe-parallel preconditions (independent files/logic, separate workers,
commits still serialized, per-worker callback tracking in the ledger) so the
knowledge isn't lost.

### A10 — Fix §3.6 "deadlocks" wording (gpt)

Mechanically inaccurate: the cycle-closing `link_prompt` is _rejected as
busy_; an async cycle _loops_. Keep the invariant, fix the consequence — and
this aligns the wording with the coordination skill's anti-pattern text.

### A11 — Reconcile §3.8 with the committer fold-in (gpt)

§1's role table allows committer→orchestrator fold-in with user permission;
the intro and §3.8 say the orchestrator _never_ commits. **Fix:** state the
fold-in as the single allowed exception in §3.8 ("never — except the §1
committer fold-in, with explicit user permission"), or drop the exception.
Recommend keeping it (it matches real usage) and pointing both texts at each
other.

---

## B. Templates findings

### B1 — New `templates/commit-brief.md` (fable #2; unanimous; spec by committer@.pi)

The COMMIT state is the only dispatch without a template, and the most
dangerous: the committer commits _another terminal's_ uncommitted work in a
repo that routinely carries unrelated dirty/untracked files from other agents
and the user. The template (structure mirroring the other briefs, with a "Why
each part" section) must contain:

**Brief fields:**

- Repo root + expected branch; first command:
  `git -C <root> status --short --branch`.
- **Commit ONLY these paths** (relative to root); whether deletions/untracked
  are expected in scope.
- Inspect commands: `git diff -- <paths>`, `git diff --cached -- <paths>`,
  `git diff --cached --name-status` (pre-staged detection).
- Prior facts: task/finding ids, reviewer APPROVE, gate results.
- Commit message: exact subject (+ body bullets), or type/scope + facts to
  compose from.
- Explicit exclusions: no version/lockfile/package changes unless listed; no
  unrelated dirty files.
- Report contract: DONE + hash + paths actually committed + post-commit
  `git status --short` (leftover dirty state) + anything suspicious;
  BLOCKED + reason otherwise.

**Operating rules (committer@.pi's field spec):**

- Never `git add .` / `git add -A` / `git commit -a` — explicit pathspecs only.
- Proceed when out-of-scope changes are clearly unrelated and unstaged;
  report them as leftovers in DONE.
- **BLOCK on:** any out-of-scope change already staged; listed paths needing
  partial staging (unless brief authorizes exact hunks); wrong branch /
  detached HEAD / merge-rebase in progress; listed path missing or renamed;
  hooks mutating files (report whether the commit landed); broad line-ending
  churn beyond listed paths (repo has CRLF warnings); commit failure
  (identity/hooks) with stderr.

**SKILL.md hooks:** §2 COMMIT references the template; one new §3 clause:
"the committer checks scope and hygiene, not correctness — never re-review."

### B2 — First-task GO variant in dispatch-brief (gpt)

`GO — <prior task> committed (<hash>)` cannot be filled for task 1. **Fix:**
add the variant line `GO — first task of the run.` with a comment.

### B3 — `templates/ledger.md` fixes (fable #9 + A7/A8 fields)

Remove the stray trailing ```fence; add`Autonomy:`field (A7) and a`## Run end` section (A8: summary posted, ledger disposed). Add committer
report column note if needed (hash column already exists).

### B4 — §5 failure-taxonomy rows for commit failures (committer)

Add one row: "Committer BLOCKED (staged junk / wrong branch / hook mutation)"
→ cause: dirty shared worktree → recovery: orchestrator relays exact
`git status` to user (worktree hygiene is the user's, not a worker's, to fix).

---

## Considered and rejected

- **Changing any of the 8 invariants' substance** — all three reviewers
  independently endorsed keeping all 8 (opus: "all load-bearing in the live
  run"). Only §3.6's consequence wording (A10) and §3.8's exception (A11)
  change; §3.4/§3.7 gain numbers, not new meaning.
- **Full parallel-pipeline support** — deferred (A9); harder than two rules
  (needs per-worker callback tracking); serial covers current usage.
- **Duplicating mechanics from pi-link-coordination** — the skill's own §7
  rule stands; all fixes stay at policy altitude.

## Sequencing

Single pass is fine (doc-only, one author): SKILL.md edits (A1–A11), then
templates (B1–B4), then a full re-read for internal consistency (state
machine ↔ invariants ↔ templates ↔ failure taxonomy all cross-reference).

**Gate (non-mechanical, doc-only):**

1. Re-read against `pi-link-coordination` SKILL.md — no contradiction, no
   duplicated mechanics.
2. Every §2 state now has: a template or an explicit non-template action, a
   WAIT semantics, and a failure-taxonomy row.
3. No remaining absolute user paths anywhere in the skill dir.
