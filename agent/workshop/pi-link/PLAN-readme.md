# PLAN — README: surface groups, regroup the CLI, remove duplication, move fine print

> **Status:** Approved by owner — run-through authorized with “Go run through!”
> **Baseline:** HEAD a2bc0a8 (README.md, 730 lines). Line anchors below are for
> that revision; re-check them when dispatching.
> **Origin:** fable's README review at the owner's request (order, reduction,
> currency, readability). Every fact in the README was checked against `index.ts`,
> `bin/pi-link.mjs`, `package.json` and `CHANGELOG.md` at this HEAD: constants,
> versions, state-field names, helper names, the 300 s budgets and the four cleanup
> lots are all current. Currency defects found so far: groups absent from user
> sections (lot 1), `agent_start` described as clearing tool calls (lot 4.7), and
> the `unsupported` message presented as a conclusive diagnosis (lot 3.5). Archon's
> review (REVIEW FEEDBACK on this plan) is folded in below; all eleven points
> were verified in source where they were factual.
> **Product scope:** `agent/workshop/pi-link/README.md` only. This plan is also
> versioned with lot 1; subsequent necessary plan amendments accompany their lot.
> No code, no skill, no CHANGELOG entry (docs-only commits do not get one in this
> repo). Facts move; no fact is invented or dropped
> unless a lot says so explicitly. **A stale fact found while contrasting README
> against code may be corrected in the lot that touches its section, provided the
> correction changes no documented contract** (payload fields, exit codes, literal
> messages). If it would, stop and ask.

## Summary

Five lots, each a commit, in priority order. **Lot 1** addresses the main
user-facing omission: terminal groups are the headline feature of this version
but are absent from the user-facing sections. **Lot 2** moves the CLI reference out of
"Configuration" into its own section and merges Architecture into Internals.
**Lot 3** removes four things said in several places. **Lot 4** moves reviewer-grade
fine print from the tool sections into Internals and shortens the three densest
paragraphs. **Lot 5** compresses the header, prerequisites and dependencies.

Target: ~500 lines with the same facts. That number is an orientation, not a
gate; it exists because this README has only ever grown.

Writing rules for every lot:

- A sentence stays in a user section if it corrects a mistake a user would
  actually make (`?` is unknown, not idle; a successful send is not a delivery;
  replies are ordinary messages). Everything that exists to be exact rather than
  to be useful goes to Internals or goes away.
- **One main explanation per fact, plus reminders where they prevent a real
  error.** Line counts given below ("three lines", "≤6 lines") are the editor's
  estimate of what the content needs, not a quota; do not cut operative
  information to hit them, and do not pad to keep them.
- **Move mechanisms, keep symptoms.** When fine print moves to Internals, the
  user-visible consequence stays where the user would hit it — usually one
  sentence in Troubleshooting with a link.

---

## Lot 1 — Groups where users read (one commit; the only urgent one)

Groups are currently mentioned twice: Limitations #8 (~537) and Internals › Name
Uniqueness (~624). Add them, briefly, at the six places a user meets naming or
visibility. One rule, stated once in full, referenced elsewhere.

- **1.1 Walkthrough (~101–140).** Rename the two terminals `builder@demo` and
  `researcher@demo` instead of `builder`/`researcher`; the `/link` output, the
  prompt and the `link_send` target follow. Add one sentence after the first
  rename: "The `@demo` part is a group: terminals see and address only names in
  their own group, so a third terminal named `builder` would not appear here."
  Keep the walkthrough otherwise identical.
- **1.2 Configuration › Naming concepts (~282–290).** Add one bullet after
  **link name**: **group** — the text after the first `@` in a link name,
  compared exactly (**case-sensitive**: `a@Team` and `a@team` are different
  groups); `archon@pi-link` is in `pi-link`, `a@g@h` is in `g@h`, and names without
  `@` (or ending in one) share the single implicit group of plain names.
  `link_list`, `link_send`, `link_compact`, `/link` and the footer see only your
  group; the hub still routes for everyone and `pi-link --status` shows all groups.
  Renaming with `/link-name` moves you. This is the one full statement; the Internals paragraph
  at ~624 keeps only what is internal (dedup suffixes the local part, the hub
  guard) and links here.
- **1.3 `link_list` (~175).** "Lists all connected terminals" → "Lists the
  connected terminals in your group". Add nothing else; link to the Naming bullet.
- **1.4 `link_send` (~171).** "pre-validated against the local terminal list" →
  "pre-validated against the terminals in your group, so a name outside it fails
  the same way a typo does".
- **1.5 Troubleshooting › Terminals don't see each other (~514–518).** First
  bullet, before the machine check: "Compare the part after `@`, exactly as
  spelled: `archon@pi-link` and `builder` are in different groups, and so are
  `a@Team` and `a@team`; they are invisible to each other by design. `pi-link
  --status` shows every group and settles it."
- **1.8 `link_compact` (~232).** "Any connected terminal can request compaction
  on another" → "Any terminal can request compaction on another **in its group**".
  Applies wherever that sentence ends up after lot 4.1.
- **1.6 Limitations #8 (~537).** Unchanged in substance; drop "their updates
  transit the wire and are stored locally" (internal) so the row fits one line.
- **1.7 Slash Commands › `/link-name` (~241).** Append: "A name with `@` also sets
  your group."

Not in scope: the coordination skill already documents groups (SKILL.md ~121).

**Check:** grep `group` in README returns hits in Walkthrough, Configuration,
LLM Tools, Slash Commands, Troubleshooting, Limitations, Internals; the full rule
appears once (1.2); every other hit is one sentence or shorter; no sentence still
says "all connected terminals" or "any connected terminal" about a group-scoped
tool.

---

## Lot 2 — Order: the CLI gets its own section, Architecture joins Internals

- **2.1 New top-level section `## CLI: \`pi-link\`** placed after Slash Commands
  and before Configuration.** Move into it, unchanged: `### Session Resume`
  (~307–323), `### Discovering sessions` (~325–353), `### Who is connected right
  now` with its `####` children Scripting/Exit codes/Notes (~355–450). Add a
  two-line lead: "`pi-link` is the optional shell launcher installed with
  `npm i -g pi-link`. It resolves sessions by name, lists them, and asks the running
  hub who is connected." Rename `### Who is connected right now` → `### \`--status\`:
  who is connected right now` so the three sub-sections read as flags.
- **2.2 Configuration (~278–305)** keeps: the "off by default" sentence, Naming
  concepts (with the new group bullet), the "What you want → Use" table, name
  normalization, name precedence, and the `/link-connect`/`/link-disconnect`
  persistence sentence. Delete the last paragraph (~305, "Once connected, terminals
  discover each other on `127.0.0.1:9900`…") — it is Architecture, and the port is
  covered by lot 3.
- **2.3 Architecture (~452–494) → Internals.** Move `### Hub-Spoke Topology`,
  `### Auto-Discovery Protocol` and `### Hub Promotion` to the top of Internals,
  before `### Protocol`. Drop the `## Architecture` heading. The intro line of
  Internals ("for contributors and developers…") now covers them, which is right:
  a user does not need the star diagram to operate the link.
- **2.4 Table of Contents (~11–27).** Reflect the new order; remove the lone
  sub-item "Who is connected right now" and list no sub-items at all (every other
  section has none). Final order: Why · Prerequisites · Quick Start · Walkthrough ·
  LLM Tools · Slash Commands · CLI · Configuration · Troubleshooting · Limitations ·
  Dependencies · Internals. (Prerequisites and Dependencies are compressed in lot 5;
  their headings survive so links keep working.)
- **2.5 Cross-links.** Every `#architecture`, `#who-is-connected-right-now`,
  `#session-resume`, `#discovering-sessions` anchor in the file is updated to the
  new heading slugs. Check with grep for `](#`.

**Check:** every `](#…)` link in the README resolves to a heading in the file
(a one-line script over headings vs. anchors is enough; do not add it to the repo),
plus the per-commit reading described under **Order and commits** — a move-only
lot can still change meaning by changing what a sentence sits next to.

---

## Lot 3 — Say it once (one commit)

Four facts are stated in several places. For each, choose the owning section and
replace the others with a link or a clause.

- **3.1 Hub promotion** — said in Architecture › Hub Promotion (~488), Troubleshooting
  › Hub promotion loses state (~520), Limitations #3 (~532), Internals › Connection
  Lifecycle (~663+). **Owner:** Internals › Hub Promotion (after lot 2). Limitations
  #3 stays as the one-line decision, but replace its imprecise name-loss rationale:
  "Reconnect order can change which terminal holds a hub-assigned suffix; in-flight
  messages can be lost." Troubleshooting keeps the symptom and the link, not an
  absolute message-loss claim or a guaranteed failover bound. Scope the name example
  to a terminal that rejoins the winner as a client: it re-registers with its saved
  preferred name rather than its prior runtime variant, so `builder-2` may return
  as `builder`, or vice versa. The promotion winner instead takes `startHub()`;
  absent the pending-rename exception, it retains its runtime identity and does not
  register. Do not say that nothing survives the gap: the old hub transfers no
  shared roster or routing state to its successor, but surviving local state such
  as the inbox remains. These distinctions must survive the shortened explanation.
- **3.2 Port 9900** — Configuration (~305), Architecture (~470), Troubleshooting ›
  Port 9900 (~498), Limitations #2 (~531), `--status` Notes (~444). **Owner:**
  Limitations #2 (the decision) and Troubleshooting (the symptom). Delete the
  Configuration sentence (lot 2.2); the Architecture mention survives as part of
  the topology text in Internals; the `--status` Note keeps the `PI_LINK_PORT`
  scope sentence and the user-visible consequence of an unusable value (exit `2`).
  Drop the stub-hub testing rationale, not that consequence or the unrelated Notes
  paragraphs on trust boundaries and flag passthrough.
- **3.3 The compaction delivery gate** — `link_compact` bullets (~226–229),
  `link_list` status prose (~196–198), Troubleshooting › no reply (~508), Internals ›
  Inbox twice (~711 and ~713). **Owner:** Internals › Inbox, merged into one
  paragraph (see 4.3). In `link_list` keep the table row and one sentence: "Only a
  manual compaction shows `compacting`; while it does, messages to that terminal
  are held." In `link_compact` keep one bullet on the gate (lot 4.1). Troubleshooting
  keeps its clause; it is the symptom.
- **3.4 The 200 ms window** — `link_send` (~162) and Internals › Inbox step 1 (~705).
  **Owner:** Internals. `link_send` keeps: "Messages arriving close together are
  usually delivered as one batch, in arrival order, each batch one
  `[Link: N message(s) received]` block." **Not a promise:** do not write "delivered
  together about 200 ms after the first" in the tool section — the compaction gate
  can hold a batch and the 20-message / ~16 000-char caps can split one
  (`flushInbox`). The number and the caps live in Internals › Inbox, where the
  constants table already is.
- **3.5 Troubleshooting › `--status` reports … an unsupported one (~510–512).**
  Currency fix, in scope per the header rule. The text says the exit-1 message
  means "something did answer but is not a hub speaking this contract". Since lot D
  of the cleanup, what is demonstrated is only that the response failed the CLI's
  printability checks; a pi-link 0.3.0 hub (which answers `426`) is one possible
  cause. Reword to: "means something answered but the response did not
  pass the CLI's checks — for example, a pi-link 0.3.0 hub, which predates the
  endpoint". Keep the "updating is not enough on its own" sentence. Apply the same
  narrowing to the identical over-claim in CLI › Exit codes prose, so it does not
  contradict Troubleshooting. Preserve the exit-code table, literal messages and
  the `426 Upgrade Required` example.

**Check:** each of the four facts has one owning paragraph; other mentions are
reminders that prevent a real error, not restatements.

---

## Lot 4 — Fine print moves to Internals; three dense paragraphs shrink

- **4.1 `link_compact` (~212–234).** Today 11 bullets. Keep in the tool section:
  what it does and the parameter table; **one** bullet per user-visible outcome:
  success (`Compacted "<name>"`), busy decline (settled-idle rule, one sentence),
  the other declines named in one bullet (`unsupported`, too small, already
  compacted — with the literal messages), self-target, and the 300 s timeout that
  bounds the wait without aborting the target. Move to a new **Internals ›
  Remote compaction** subsection: the `ctx.compact()` mechanics, how and when a
  cancelled compaction's gate is released (next agent run, later successful
  compaction, or the 300 s backstop), caller-abort semantics, the "raises both
  flags" detail, the concurrency and cooperating-peers lines (with 1.8 applied).
  Six bullets stay; five move. **The cancelled-compaction symptom stays visible:**
  add one sentence to Troubleshooting › "I sent a message but got no reply" (~508):
  "If the target cancelled a `/compact`, pi-link cannot see that, so its messages
  may stay held until its next run or up to five minutes" with a link to the
  Internals subsection.
- **4.2 `link_list` (~173–210).** Keep: the first paragraph, the cwd and context
  sentences, the status table, one sentence on `tool:<name>` ("the first call
  still running, not a list"), the `compacting` sentence from 3.3, "durations are
  computed at render time", "just-joined terminals render blank, not idle", and the
  example. **Fix the `thinking` row of the table (~186)** before moving anything:
  "LLM is generating" is too narrow once the paragraph below it goes. Row text:
  "Work Pi has not settled yet — the LLM call, plus any automatic retry or
  compaction". Then move to Internals › Agent Lifecycle Integration (which already
  covers most of it): the events behind that definition (~194) and the "manual
  compaction runs briefly before the gate rises" sentence (~198). Where Internals
  already says it (its `agent_end`/`agent_settled` bullets do), delete rather than
  move.
- **4.3 Internals › Inbox (~699–720).** Merge the two gate paragraphs (~711, ~713)
  into one of ≤6 lines: which two flags gate, why (context being rebuilt), that
  automatic compaction is not gated and why, that a gated flush does not
  reschedule so `releaseInbox()` and `compactDeadline` are the release paths. Drop
  the `/compact` timing-gap sentence unless a Troubleshooting entry depends on it
  (none does).
- **4.4 Internals › Agent Lifecycle Integration, `pushStatus` paragraph (~695).**
  Ten lines → three: "Each of these handlers recomputes the status and hands it to
  `pushStatus()`, which publishes only when the display identity changed since the
  last publish, so a second concurrent tool or a mutation beneath a raised gate is
  silent. `disconnect()` clears that baseline; the next forced push (`welcome`) or
  handler event restores it. `session_compact` always pushes."
- **4.5 `--status` › "Everything above is what the hub sends…" (~428).** Nine
  lines → about three: "The CLI validates only the fields its table prints —
  `terminals` as an array of objects with string `name`, optional string `cwd`,
  `context` as `null` or `{ tokens, window }`, and `status`/`sinceSeconds`
  together or absent. A body failing that exits 1 with the unsupported message
  instead of a stack trace, **in both modes**. A zero exit certifies nothing beyond
  printability — not order, not `hub`, not even that a hub answered. Once the body
  passes, `--json` writes it as received, unreformatted." **Verified:** `runStatus`
  calls `isStatusPayload` (bin ~693) before the `state.json` branch (~695), so
  "`--json` is unaffected" / "verbatim regardless" — present in the README today and
  in the first draft of this plan — is false and must not survive. Same fix in the
  `#### Scripting` lead (~376) if it implies `--json` bypasses the check.
- **4.6 State Management table (~636–654).** Keep; all 16 names were verified
  against `index.ts` at this HEAD. Do not extend it.
- **4.7 Internals › Agent Lifecycle Integration, `agent_start` bullet (~686).**
  Currency fix, in scope per the header rule. Delete "Also drops any tool calls
  left recorded": `agent_start` no longer calls `activeTools.clear()` (removed in
  cleanup lot A, commit 0595e67; verified at this HEAD — only `agent_end` clears).
  The rest of the bullet (sets `agentRunning`, clears the local gate, the
  deployment caveat) is still true; the caveat may be shortened by 4.4's standard.

**Check:** the tool sections contain no sentence about `ctx.compact()`, flags,
`agent_end` or `session_before_compact`; those words appear only under Internals.
("Retry" may appear once, in the `thinking` table row.) Every symptom whose
mechanism moved has one sentence left in Troubleshooting or the tool section.

---

## Lot 5 — Header, prerequisites, install notes, dependencies

- **5.1 Header (~1–9).** Delete the first paragraph ("A WebSocket-based
  inter-terminal communication system…"). Promote the blockquote to the opening
  line, unquoted, plus the Discord sentence. Two paragraphs, not three.
- **5.2 Prerequisites (~40–47).** Two bullets: Pi ≥ 0.84.2, stable `x.y.z` only
  (older Pi: `pi-link@0.2.x` for 0.74–0.84.1, `@0.1.14` below) · "Node.js (LTS
  recommended)" — **a recommendation, exactly as today; do not harden it into a
  requirement**. Keep
  the refusal paragraph but cut it to two sentences: `pi install` does not check
  the host version; pi-link refuses to initialize and Pi reports it under
  **[Extension issues]** with the floor and the detected version.
- **5.3 Notes on installation (~95–99).** Replace the paragraph with one sentence
  under "Optional: shell launcher": "Pi installs packages into its own npm root
  (`~/.pi/agent/npm/`), which is not on `PATH`; `npm i -g pi-link` is what puts
  the `pi-link` command there." Drop the issue link and the "safe together" line.
  Delete the `### Notes on installation` heading.
- **5.4 Dependencies (~541–565).** Three tables → one paragraph: runtime `ws`
  (installed by `pi install`); dev `@types/ws`; provided by Pi: the SDK, pi-tui
  and typebox. Keep the heading so the TOC entry and any links survive.
- **5.5 Limitations table (~526–539).** Keep all eight rows; trim each rationale
  to one line where it currently wraps (rows 4, 7, 8). No row is removed.

---

## Order and commits

1. Lot 1 — alone, first; it can ship even if nothing else does.
2. Lot 2 — moves only; `git diff --stat` should show near-zero net change.
3. Lot 3, then Lot 4 — reductions; keep one main explanation per fact, plus
   reminders where they prevent a real error.
4. Lot 5 — polish.

Each commit: `docs(pi-link): …`. **Independent review by `reviewer@pi-link` after every lot**, including
the move-only and polish lots: a short documentary reading for coherence, examples
still matching their prose, links resolving, and — above all — no accidental
change of meaning (a recommendation hardened into a requirement, a "usually" turned
into a guarantee, a symptom lost when its mechanism moved). A link check alone
catches none of those. No code suites are involved; nothing binds a port.

## Execution contract

- **Authority:** owner explicitly approved “Go run through!” after the five-lot
  order, documentary gates, roles and inclusion of this plan in the first commit
  were presented. No per-commit owner prompt is required within this outcome.
- **Repository:** `C:/Users/andre/.pi`, branch `master`, initial HEAD
  `a2bc0a870588f53ba4c1d6c8e4617a242879c290`. Each later lot starts from the previous
  lot's committed HEAD, explicitly pinned in its dispatch.
- **Roles:** orchestrator `archon@pi-link`; implementer `implementer@pi-link`;
  independent reviewer `reviewer@pi-link`; committer `committer@pi-link`.
  This owner-approved binding replaces the draft's review assignment to fable.
  Each worker must independently confirm identity, repository, branch/HEAD and
  index before engagement; reported cwd alone is not proof.
- **Allowed paths for every lot:** `agent/workshop/pi-link/README.md`; and
  `agent/workshop/pi-link/PLAN-readme.md` for the orchestrator's execution contract
  and necessary amendments only. Implementer edits the README, not this plan.
  Initial expected dirt is this untracked plan and the orchestrator's ledger;
  README is clean and the index is empty. After lot 1, only the ledger should
  remain untracked. No plan deletion is authorized by this run.
- **Private run state:** `C:/Users/andre/.pi/agent/workshop/pi-link/LEDGER-readme.md`.
  Orchestrator owns it, updates it at transitions, and deletes it at closure.
  Workers must not read/edit/stage it; it is never a reviewed product artifact.
- **Standing exclusions:** root `README.md`, BACKLOG, all REPORT files and their
  issue contents, code/tests, installed copies, skills, CHANGELOG, versions,
  package/lockfiles and dependencies. No install, reload, push, publish or live
  fleet check. Report-byte hashing is preservation hygiene, not issue assessment.
- **Serial pipeline:** implement and self-gate one lot, independently review its
  actual diff (including any plan amendment), then commit before implementing the
  next. No worker-to-worker delegation. All callbacks go to Archon; WAIT ends the
  turn. No polling. No staging/committing by implementer or reviewer.
- **Convergence:** at most two shared repair rounds per lot after its initial
  implementation, across gate and review together. Must-fix and missing required
  evidence block; should-fix is routed; nits are recorded. Remaining must-fix at
  the cap, factual disputes, changed outcomes or material risk escalate to owner.
  Material declarations and rationale are relayed verbatim to the reviewer.
- **Context:** assess before each stage and at each committed boundary, using the
  owner's healthy reference of 200K with repair/handoff reserve, not the model's
  full advertised window as a target. Compact idle workers before engagement
  when needed; never compact an engaged worker before that lot's commit.

### Required documentary gate — every lot

Before edits, implementer verifies branch/HEAD, full worktree and entire staged
state, expected dirt, absence of merge/rebase, and reads this plan against the
current README and task-relevant source. Establish the current link/whitespace
baseline and four REPORT byte hashes without opening report contents. Known
stale statements assigned to later lots are deferred by this plan, not an excuse
for unrelated repairs or a requirement to implement later lots early. Unexpected
state, a failing applicable baseline or a plan/source contradiction means BLOCKED
with facts and a proposed resolution; never reset/clean another person's work.

After edits, implementer self-runs and reviewer independently verifies:

1. Actual task diff and current README: intended moves/reductions/corrections,
   readable flow, coherent examples, unchanged actual contracts and user-visible
   consequences retained. For a move-only lot compare the moved material, allowing
   only the explicitly specified heading/lead/link edits. The near-zero line delta
   and estimated prose lengths are guidance, not acceptance tests.
2. Source inspection of changed factual claims at narrow `index.ts` / CLI /
   package / changelog anchors as applicable. This is documentation evidence,
   not execution of those behaviors. Reuse unchanged earlier evidence explicitly;
   never treat a prior approval as evidence for a newly changed statement.
3. All README internal heading links resolve using Markdown/GitHub-compatible
   slugs; local file targets exist; changed examples and TOC agree. External URLs
   are checked as text, not fetched. Any temporary checker stays outside the repo;
   no new dependency, committed test harness, port binding or browser/live test.
4. `git diff --check` succeeds; README retains its established CRLF convention
   without mixed endings or broad normalization. Plan remains UTF-8/LF with final
   newline; validate its untracked bytes explicitly in lot 1 because `git diff`
   omits them. No new trailing whitespace or unexpected encoding changes.
5. Exact allowed scope, empty index before commit, no unexpected untracked files,
   protected ledger untouched by workers, no outside-scope tracked diff, and the
   four REPORT byte hashes unchanged from baseline. Check actual bytes rather
   than treating the repository's autocrlf advisory as a failure.

These checks plus the lot-specific checks are required. No runtime suite/build
is required for this documentation-only change; no inherited test total may be
claimed as freshly run. Correctness belongs to the independent reviewer.

### Commit and closure

The committer verifies scope/staging hygiene, not correctness. Explicit pathspecs
only: README plus this plan when new or amended; never the ledger. Inspect the
entire staged path list, use normal hooks, and verify post-commit status. No
`git add .`, `git add -A`, `git commit -a`, amend, hook bypass or cleanup of others'
work. Unexpected branch/HEAD, partial staging, out-of-scope staging, broad newline
churn or hook mutation blocks; report whether a commit nevertheless landed.

Commit subjects, one per lot:
1. `docs(pi-link): surface terminal groups in user guidance`
2. `docs(pi-link): separate CLI reference from internals`
3. `docs(pi-link): consolidate repeated explanations`
4. `docs(pi-link): simplify tool guidance and correct technical details`
5. `docs(pi-link): streamline introduction and installation notes`

At closure report the five hashes, final documentary gate/review, limitations and
routed findings; delete only the private ledger. Keep this plan. No release or
backlog implementation follows automatically.

## Out of scope

- The coordination skill (`skills/pi-link-coordination/SKILL.md`): already covers
  groups; any style pass there is a separate decision.
- CHANGELOG: no entry for a docs-only change.
- Any wording that changes a documented contract (payload fields, exit codes,
  messages). If a lot seems to require it, stop and ask.

## Kept on purpose

- The "X, not Y" sentences that correct a real user mistake: `?` is unknown, not
  idle; a successful send is not a delivery; a reply is an ordinary message; idle
  in `link_list` is what was true a moment ago. Others of that shape are candidates
  for lots 3–4, not protected.
- The `--status` JSON contract table and the exit-code table: they are what a
  script author reads, and they are already tight.
- The Walkthrough and the two "which tool / what you want" tables: the parts of
  the README that already work for humans.
