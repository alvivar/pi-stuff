# PLAN — pi-link-orchestration review fixes (F1–F4)

Fix the three findings from the every-line-justified review (2026-06-12, fable)
of the post-improvement skill, plus the owner-decided rename (F4). Doc-only: three file edits plus a directory rename. Baseline: skill dir
clean at `ffee92c`+rename (staged); findings verified against the live pipeline
run that executed PLAN-improvements.md.

This plan follows the skill's own `templates/plan-schema.md` — exact
before/after, anchors, per-finding risk/verify — so it can be executed either
directly or through the pipeline without re-derivation.

---

## F1 — commit-brief: operating rules must ride INSIDE the fence (defect)

**Where:** `templates/commit-brief.md` — the fenced template's `Exclusions:`
paragraph and the `Or BLOCKED…` line; the `## Operating rules (committer-side)`
section below the fence.

**Problem:** The fenced text (what actually gets dispatched) says "report them
per the operating rules" and "(operating rules below)" — but the rules live
below the fence in this file, which the committer never receives. The dispatch
is not self-contained, violating SKILL.md §3.2. Proven hazard shape: the live
run's committer only behaved correctly because it authored the spec.

**Fix (three coordinated edits in one file):**

1. In the fence, replace:
   ```
   Exclusions: no version bumps, lockfiles, or package manifests unless listed
   above; do not stage or commit unrelated dirty/untracked files — leave clearly
   unrelated unstaged leftovers in place and report them per the operating rules.
   ```
   with:
   ```
   Exclusions: no version bumps, lockfiles, or package manifests unless listed
   above; do not stage or commit unrelated dirty/untracked files.

   Operating rules:
     - Explicit pathspecs only: git add <path> <path>. Never git add . / -A /
       commit -a — the worktree is shared.
     - Scope and hygiene only: verify the staged diff matches the path list;
       correctness was settled at review — do not re-review.
     - Proceed when out-of-scope changes are clearly unrelated AND unstaged —
       leave them in place, report them as leftovers in your DONE.
     - BLOCK on any of: staged out-of-scope changes · a listed path needing
       partial staging (unless this brief authorizes exact hunks) · wrong
       branch / detached HEAD / merge-rebase in progress · a listed path
       missing or renamed · hooks mutating files (say whether the commit
       landed) · broad line-ending churn beyond the listed paths.
   ```
2. In the fence, replace:
   ```
   Or BLOCKED + reason (operating rules below); on commit failure include the
   exact stderr.
   ```
   with:
   ```
   Or BLOCKED + the rule that fired; on commit failure include the exact stderr.
   ```
3. Replace the entire `## Operating rules (committer-side)` section (header +
   all bullets) with:
   ```
   ## Note on the operating rules

   The rules live INSIDE the fenced brief, not here: the committer never sees
   this file, only the dispatch (SKILL.md §3.2 — self-contained dispatch).
   Never send the brief with the rules trimmed out.
   ```
   The 8 BLOCK conditions survive verbatim-in-substance inside the fence
   (edit 1); keeping a second full copy here would just be a divergence risk.

**Risk:** low. Content moves, one duplicate copy is eliminated; the 8 BLOCK
conditions must survive the compression — that is the verify step.

**Verify:** (a) every concept from the old operating-rules section maps into
the new fence block (pathspecs, scope-not-correctness, proceed rule, all 8
BLOCK conditions, stderr-on-failure); (b) nothing inside the fence references
content outside it; (c) "Why each part" still reads correctly (its bullets
reference rules now located in the fence — adjust wording only if a bullet
points at "the section below").

---

## F2 — review-brief: untracked/new-file diff blind spot (gap, field-proven)

**Where:** `templates/review-brief.md` — the fenced template's `Diff:` line and
the `## Notes` section.

**Problem:** `git diff -- <relative file path>` silently shows nothing for new
(untracked) files. Hit live in the pipeline run's Task 2 (new commit-brief.md);
the orchestrator improvised "read it directly" — the template never learned it.

**Fix (two edits):**

1. In the fence, after the `Diff:` line, add:
   ```
   New files (if any) are untracked — git diff shows nothing for them; read
   them directly:  <absolute path(s) or "none">
   ```
2. In `## Notes`, add one bullet:
   ```
   - **New files don't diff** — untracked files are invisible to `git diff`;
     always route the reviewer at the file itself, or the review silently
     covers only the modified files.
   ```

**Risk:** none (pure addition).

**Verify:** filled-brief simulation against the live run's Task 2 (one new
file + two modified) produces a complete review instruction with no improvised
text needed.

---

## F3 — SKILL.md H1: rename residue (cosmetic; target set by F4)

**Where:** `SKILL.md` line 6, the H1.

**Problem:** Frontmatter and H1 disagree — the H1 still says
`# Orchestrate Code Pipeline`, two renames behind. First line an agent reads
after loading; it must match the F4 name.

**Fix:**
```
- # Orchestrate Code Pipeline
+ # Implement → Review → Commit
```

**Risk:** none.

**Verify:** covered by F4's residue sweep.

---

## F4 — Rename skill to `pi-link-implement-review-commit` (owner decision)

**Where:** the skill directory and `SKILL.md` frontmatter.

**Problem:** `pi-link-orchestration` claims the whole category, but this skill
is one configuration of it — the serial, plan-driven implement→review→commit
loop. Future configurations (parallel fan-out, debate review, …) need the
generic name free, and the owner wants this one to read as a worked example:
the name IS the loop.

**Fix:**
1. `git mv agent/skills/pi-link-orchestration agent/skills/pi-link-implement-review-commit`
2. Frontmatter: `name: pi-link-orchestration` →
   `name: pi-link-implement-review-commit`
3. H1 per F3 (`# Implement → Review → Commit`).
No other by-name references exist (the companion reference points at
`pi-link-coordination`; templates reference `SKILL.md §…` relatively).

**Risk:** none in-repo. Running terminals keep the old name in their system
prompts until restart; nothing references the skill by name in code.

**Verify:**
`grep -ri "orchestrate-code-pipeline\|Orchestrate Code Pipeline\|pi-link-orchestration"`
over the renamed dir → zero hits.

---

## Considered and rejected (rulings from the review — do not "fix")

- Fold-in exception at 5 sites in SKILL.md — deliberate reinforcement; each
  site is a complete decision point (same ruling as coordination-skill dedup).
- §3.9 thrice in commit-brief.md — costs nothing in the dispatched fence;
  F1's edit 3 removes one instance anyway as a side effect.
- Taxonomy row for "link_compact errors but target actually compacted" —
  mechanism-level, lives in REPORT-compact-race.md / upstream, not policy.

## Sequencing & gate

Single pass; do F1/F2/F3 file edits first, F4's `git mv` last so edit paths
stay stable; one commit:
`docs(skills): rename to pi-link-implement-review-commit and fix review findings (F1-F4)`.

Gate (doc-only):
1. Nothing inside any fenced template references content outside its fence
   (sweep all three briefs, not just commit-brief).
2. All 8 BLOCK conditions present in the commit-brief fence.
3. Zero occurrences of ANY prior skill name in the dir (orchestrate-code-pipeline,
   pi-link-orchestration — F4 sweep).
4. No absolute user paths introduced.

Disposition: plan is delete-after-done once committed.
