# Rename the bundled skill to pi-link-tools

## Authorization and baseline

Status: AUTHORIZED, run-through, one coherent task/commit.
Preparation instruction: "Prepara el plan y lo que necesitas. Clasicos participantes, contexto a 200k."
Owner execution GO: "Go, run through!"
This GO authorizes baseline -> implementation/selfgate -> independent review ->
commit for R1 as specified here. No installation, reload or publication follows.
Owner later ratified the installed-skill evidence exception below with:
"Continua, go, run through!" after an explicit explanation of the missing baseline.
Earlier lightweight editing instructions are superseded for THIS run by the
owner's invocation of pi-link-implement-review-commit. Archon orchestrates only.

Repository: C:/Users/andre/.pi
Branch: master
Expected HEAD: 484af86a1829e053f5667da1ef5cd5d857717fcf
Observed before creating this plan: clean worktree, empty index.
The owner's recent skill simplifications are already committed in that baseline;
retain the current 63-line skill, not an older version from a handoff or install.
Node observed: v24.19.0. Do not assume baseline tests have been run for this task.

Plan: C:/Users/andre/.pi/agent/workshop/pi-link/PLAN-skill-tools-rename.md
Temporary ledger (NEVER staged):
C:/Users/andre/.pi/agent/workshop/pi-link/LEDGER-skill-tools-rename.md
Expected preparation dirt: this plan and ledger only; index remains empty.
Worker role confirmations and subsequent states belong in the ledger.

## Outcome

Rename the bundled skill to pi-link-tools, keep active documentation and its
local dependent policy skill consistent, and remove task-cycle assumptions from
the small set of related public tool/README strings identified during planning.
No transport, lifecycle, routing, timeout, parameter or result-details changes.
One intentional observable error-text change: self-compaction rejects with
"Cannot compact yourself." instead of suggesting an unavailable model command.

The new name is used for discovery and /skill:pi-link-tools. No old-name alias
or duplicate skill is retained. Pi supports a name differing from the directory,
but both are renamed for consistent paths and Agent Skills interoperability.

The product manifest already discovers ./skills and publishes the skills tree;
package.json and package-lock.json require NO change. Installed copies and
running sessions remain unchanged until a separately authorized update/reload.

## Roles, context and workflow

Proposed classic bindings, independently confirmed before execution:
- Orchestrator: archon@pi-link
- Implementer: implementer@pi-link
- Independent reviewer: reviewer@pi-link
- Separate committer: committer@pi-link

Each worker verifies identity, root/branch/HEAD and state; cwd alone is not proof.
Designer supplied planning input; no execution role or direct worker delegation.
All communication goes through Archon. Read the plan before acting.
Use 200K as the owner's working context reference even for larger windows; leave
room for review/repair/handoff. A '?' is unknown, not a compaction-failure signal.
Check headroom before every stage. Compact only idle workers at safe boundaries;
never shed an engaged implementer/reviewer's context through this task's commit.

Explicit GO required before the implementer's baseline. Under run-through, the
single GO covers baseline -> implement/selfgate -> independent review -> commit.
If gate-per-task is chosen, obtain another owner GO immediately before commit.
Maximum two shared repair rounds for failed required gates or must-fix findings.
At exhaustion or material risk/outcome change: stop and escalate, no silent waive.
WAIT means end the turn; do not poll, sleep or send a second work brief.

## Task R1 — Rename and align tool guidance (one commit)

This is one small coherent task. Its references share README files; splitting
into multiple commits would add temporary inconsistencies rather than isolate
independent behavior. Verification combines exact text/blob checks, real skill
loading and the unchanged lifecycle suite; no new tests or test scaffolding.

### Allowed product paths (relative to repository root)

1. README.md
2. agent/skills/pi-link-implement-review-commit/SKILL.md
3. agent/workshop/pi-link/README.md
4. agent/workshop/pi-link/skills/pi-link-coordination/SKILL.md (delete via move)
5. agent/workshop/pi-link/skills/pi-link-tools/SKILL.md (new destination)
6. agent/workshop/pi-link/index.ts
7. agent/workshop/pi-link/CHANGELOG.md
8. agent/workshop/pi-link/PLAN-skill-tools-rename.md (this plan)

Ledger is permitted temporary bookkeeping, NOT a product/staging path.
Temporary checkers/evidence may be written under:
C:/Users/andre/AppData/Local/Temp/pi-link-skill-tools-484af86/
No other file additions/edits without a recorded scope amendment and authority.

### Exact change boundaries

A. Move skills/pi-link-coordination/SKILL.md to skills/pi-link-tools/SKILL.md.
   Implementer uses a filesystem move, NOT git mv (which would stage changes).
   Committer alone stages the explicit old/new paths after independent approval.
   Change ONLY frontmatter name to pi-link-tools and H1 to Pi-Link Tools.
   Preserve the owner's entire current body and quoted description byte-for-byte.
   Do not restore removed sections/paragraphs, reflow bullets or re-audit the skill.

B. Active references:
   - Root README: two references (currently lines64,78) become pi-link-tools;
     the dependent policy paragraph calls it the "tool-use skill" rather than
     the "general coordination skill". Preserve surrounding installation text.
   - Local policy SKILL: only replace the old name in description and prerequisite
     (currently lines3,13). Do not alter its roles, workflow, gates or policies.
     This file is outside the npm package but inside THIS repository and in scope.
   - Package README three-tools paragraph (currently139):
     "Three tools: `link_send` to talk to another terminal, `link_list` to see who
     is there, and `link_compact` to trim another terminal's context. pi-link also
     ships a **pi-link-tools** skill describing how they behave."
     Keep the existing paragraph layout; no unrelated formatting changes.
   - Package README success-result bullet (currently212): retain only
     '- **Success** result: `Compacted "<name>"`.' Delete the following sentence;
     do not restate the result, promise current idleness or prescribe next work.
   - Package README self-target bullet (currently215) becomes:
     '- **Self-target rejection** — calling `link_compact` on yourself returns a
     `self_target` error (`Cannot compact yourself.`).'
     Preserve paragraph layout. This must match C.3, not describe the removed
     /compact hint. Do not change other outcomes/literals.
   - Preserve "manual compaction" in README185/213: that is valid Pi reason
     terminology, including ctx.compact(); no global manual->remote replacement.
   - Preserve human orchestrator/workers examples, example names, architecture,
     walkthrough, CLI reference and every unrelated README paragraph.

C. index.ts: exactly three text edits, no code/control-flow changes:
   1. Delete the standalone description-array entry
      "Returns once the target has compacted, so you can immediately send it new work."
      including its comma, indentation and line ending. The first sentence already
      says to wait until completion; retain first and guard entries, joined as now.
   2. In link_compact description only, "no manual compaction holds its gate"
      -> "no compaction holds its gate".
   3. "Cannot compact yourself - use /compact."
      -> "Cannot compact yourself."
   Preserve details.error='self_target', target identity, rejection timing,
   signal/disconnected precedence, status metadata and every other literal.
   Both localCompacting and compactRunning still block remote admission; this
   wording aligns with that existing predicate, it does not broaden the guard.
   No edits to link_send/list schemas/descriptions, prompts or wire headers.

D. Historical documentation:
   - CHANGELOG: add one concise entry under Unreleased/Changed explaining the skill
     rename (old -> new), /skill:pi-link-tools invocation, and related wording
     changes including self-target error text without changing rejection behavior.
     Published version entries (0.3.0/0.1.7 old-name references) remain byte-identical.
   - PLAN-readme.md is closed historical evidence: preserve the ENTIRE file,
     including the old path near435 and generic reference near93.
   Old-name occurrences in CHANGELOG history/rename note, closed PLAN-readme,
   this plan and the private ledger are intentional. No global replacement.

### Standing constraints

- No edits by the orchestrator to product or tests, no correctness verdict from it.
- Implementer/reviewer never stage or commit. Committer performs hygiene only.
- No broad content searches: enumerate explicit relevant files; exclude REPORT-*
  from content inspection/searches. Reports are neither assessed nor modified.
- No versions, dependencies, locks, manifest edits, installation, reload, release,
  live-mesh exercises, global skill copies, transport features, retries or auth.
- No reset/clean, push/amend, skipped hooks, broad staging or owner's-work cleanup.
- Preserve UTF-8 and final newline, and each file's existing line-ending style:
  LF: root README, local policy SKILL, this new plan/ledger.
  CRLF: package README, renamed SKILL, index.ts, CHANGELOG.
  Tests and historical PLAN-readme remain wholly byte-identical.
- Unexpected HEAD, index dirt, merge/rebase, unrelated drift or red baseline blocks
  execution. Report facts, do not silently fix them. No claiming branch sync from
  a local status. The existing installed skill is older and is not a source.

## Required verification

Baseline is the IMPLEMENTER's first execution stage after explicit GO. Afterwards,
run the post-change checks below; the reviewer independently reruns those checks
and verifies the baseline evidence. Do not expect the old name after the rename.
Record commands, counts, outputs and limitations in the external evidence dir;
no historical gate total is fresh evidence for this diff.

### Ratified installed-skill evidence exception

The implementer omitted the PRE-edit installed-skill hash required by Baseline1.
This was discovered at the orchestrator's completeness gate, before independent
review or commit. The historical measurement does not exist and is NOT recreated.
The initial statement that the installed copy was untouched was a scope inference,
not a pre/post measurement. This is evidence repair1/2, not a product repair.

After disclosure and recommending no copying/reloading of terminals, the owner
explicitly said "Continua, go, run through!", authorizing this bounded amendment:
- Measure ONLY the current installed skill at
  C:/Users/andre/.pi/agent/npm/node_modules/pi-link/skills/pi-link-coordination/SKILL.md.
- Require its SHA256 to equal the PRE-edit SOURCE skill captured in baseline-bytes:
  306af52b856f575d1b0916169a0ed6c0241cf7550cffc7bd0cc78b3fb4bfe8ad.
  Confirm the installed skill still uses its old name/path and no renamed copy
  exists there. This validates current installed state against an independent
  pre-rename source reference, NOT that the installation was unchanged throughout.
- Record the original omission, current observation and owner ratification in
  evidence and final limitations. Timestamps do not substitute for missing hashes.
- Rerun the required post-change gates; reviewer independently verifies this
  amended check and all unchanged gates. No test/install/reload scope expansion.

All other baseline requirements/evidence stand. The paragraph below retains the
original installed-capture requirement as history, subject ONLY to this exception.
No other missing required check is waived; no future omission is pre-authorized.

### Baseline, before edits

1. Verify root/master/expected HEAD, empty index, no merge/rebase and exact known
   dirt (untracked plan+ledger only). Capture in-scope bytes/hashes and protected
   manifests/installed skill/tests/closed PLAN-readme; opaque report hashes
   allowed but not content reads.
2. From C:/Users/andre/.pi/agent/workshop/pi-link run:
   `node test/lifecycle-compact-test.mjs`
   Required exit0/all checks pass, no live sockets. This imports real extension
   under mocks and exercises both compaction gates/settled lifecycle.
3. Run actual Pi skill discovery against ONLY this package's skills directory,
   using loadSkillsFromDir from the installed SDK:
   C:/Users/andre/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js
   API: loadSkillsFromDir({dir: absolutePackageSkillsDir, source: "rename-gate"}).
   Expect one skill pi-link-coordination, correct absolute file/base paths,
   current full description, no diagnostics. Read-only SDK import, no Pi session.
4. `git diff --check`, UTF-8/line-ending checks and active-reference inventory.
   Any failure blocks before editing. Do not run broad installed/global discovery.

### After implementation / independent review

1. Rerun the UNCHANGED lifecycle suite, exit0/all pass. Existing manual/remote
   gate tests must remain and pass. No new tests, changed assertions or harness.
2. Rerun real SDK discovery: exactly one pi-link-tools at new path, same quoted
   description value, no old-name duplicate and zero diagnostics. Old source
   directory absent. This validates discovery/parsing, not installation/reload.
3. Verify blob boundaries mechanically against baseline484af86:
   - Renamed SKILL equals old blob with ONLY name/H1 substitutions.
   - index.ts equals baseline with EXACTLY the entry deletion and two text
     substitutions in C. Everything else, including self_target details and
     guard branches, is byte-identical.
   - Policy SKILL equals baseline with ONLY two old-name substitutions.
   - Published CHANGELOG suffix (from 0.4.1 heading onward) is byte-identical.
   - Entire PLAN-readme and existing tests are byte-identical.
   Inspect the self-target branch and README215 correspondence explicitly: exact
   new error text, unchanged error code/target, no remaining /compact-hint claim.
4. Active references: explicit-file scan of root README, package README, local
   policy SKILL, new SKILL, manifest and relevant source/tests. No old skill name
   remains there. Enumerate intentional historical occurrences separately. Verify
   all changed local link/path targets, YAML frontmatter and skill-command naming.
   Read new/untracked SKILL and plan DIRECTLY: git diff alone omits them.
5. Scope/bytes: allowed-path status only (ledger excluded from staging), index empty
   until committer, UTF-8/newlines/EOL styles unchanged, git diff --check clean.
   Manifests, locks and every other tracked path unchanged. For the installed
   copy apply the ratified exception above; do NOT claim pre/post immutability.

Required evidence is limited to the changed surfaces and guards. No fresh full
suite/native-renderer/CLI/network/live UI claim is made. No install/reload gate.
New description/error strings and unchanged self-target guard semantics are
verified by exact source/blob checks and independent source inspection, NOT by
new execution of the self-target branch. Existing lifecycle tests do not cover
that call. This source-based coverage choice is explicit and proportionate to
literal-only changes; do not report it as runtime self-target validation.
If the current SDK/test harness cannot run a required check, report BLOCKED rather
than swapping source reasoning for runtime evidence or installing dependencies.
Optional: additional static link/Markdown checks in a temp file; not a new product
linter/framework. Never run wire-dup-register-probe or live test as part of this run.

## Review, commit and closeout

Review actual baseline-to-worktree changes, new skill/plan files and evidence;
relay implementer's material declarations verbatim. Must-fix/required-evidence
failure blocks; should-fix routed explicitly; nit recorded only. Two repairs max.
Highest risks: preserving the owner's current skill; active dependency references;
actual self-target rejection contract; no gate/lifecycle code change; no history
rewrite or installed-copy mutation. Report uncovered runtime surfaces honestly.

Commit after independent APPROVE and applicable owner GO, with explicit pathspecs
for the allowed files including both sides of the rename and this plan. Exclude
LEDGER-skill-tools-rename.md and all temp evidence. Do not use git add -A/. or -a.
Suggested subject: docs(pi-link): rename skill to pi-link-tools and align guidance
Normal hooks only; block on hook mutation and report whether a commit landed.

At closeout record commit hash, scope, independent verdict, required checks and
limitations; delete ONLY the private ledger. Keep this plan. No publication,
installation, reload or work on unrelated historical plans follows automatically.
