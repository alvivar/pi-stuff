# PLAN: README reshape pass (compressed)

Step-back rewrite of `README.md` targeting the highest-value front-door drift. This plan compresses a previous 6-phase scope to 3 editing phases + validation. Three phases from the prior revision are deferred — they fix real but lower-impact issues, and they are the most-risky/maintenance-heavy parts of the original plan.

**Revision history:**

- Rev 1 — initial 6-phase plan
- Rev 2 — incorporated `gpt@pi-link` + `opus@pi-link` review pass
- **Rev 3 (current)** — compressed scope per `gpt@pi-link` + `docs@pi-link` + `opus@pi-link` consensus: keep front-door wins, drop higher-effort/lower-value phases. Folds in `gpt`'s Concepts-as-Configuration-subsection and `docs`'s install-callout-to-footnote amendments.

## Goals (compressed)

1. Reader hits the doc and lands on a clear default path within 30 seconds. Advanced options are reachable but don't crowd the entry.
2. The name story (link name vs Pi session name vs saved `/link-name` vs `--link-name` flag) is decomposed in one place, not scattered as inline clarifications.
3. The opening leads with user value, not implementation.

**Deferred goals from rev 2 (still real, lower priority):**

- ~~Walkthrough demonstrates orchestrator/worker~~ — current walkthrough is thin not wrong; aspirational coverage, highest-write-cost phase, hardest to keep accurate over time
- ~~Internals diet (State Management table cut, Connection Lifecycle trim)~~ — cleanup, not first-run critical
- ~~Limitations cleanup (move rename-during-prompt edge case)~~ — operational nuance, not front-door

These deferred goals are real. If the compressed pass lands cleanly and there's appetite to continue, they become a fresh follow-on plan — not a re-resurrection of rev 2.

## Non-goals

(Unchanged from rev 2.)

- **No content drift.** Every behavior currently documented either stays documented or moves explicitly. Nothing gets silently dropped.
- **No CHANGELOG edits.** History is not cruft.
- **No SKILL.md edits.** Already clean per recent audit.
- **No new features documented.** This is reshape, not feature work.
- **No section renames.** Anchor links to current sections must continue resolving.
- **No `PI_LINK_NAME` in user-facing precedence ladder or table.** Don't surface internal mechanism in user-facing surfaces.
- **No length target.** The doc should be as long as it earns. Side-effect, not goal.

## Out of scope (sections not touched)

- Prerequisites — fine as-is
- Slash Commands — recently audited, accurate
- Architecture (Hub-Spoke + Auto-Discovery + Hub Promotion) — accurate, well-shaped
- Troubleshooting — fine as-is
- Dependencies / Provided by Pi / `package.json` block — recently audited, accurate
- **Walkthrough** — deferred from rev 2
- **Internals** (entire section) — deferred from rev 2
- **Limitations** — deferred from rev 2

If a reviewer flags one of these as having a real issue, that's a separate concern; this plan won't preemptively touch them.

## Phases

Three editing phases + validation. Executed continuously in one work pass. Estimated time: **~2 hours**.

### Phase 1 — Quick Start compaction + install-callout footnote move

**Current state:** Quick Start shows two startup methods plus a 4-line "Why two installs?" callout explaining the Pi 0.75 PATH discoverability issue. The callout is accurate but interrupts the running-the-thing path right where Goal 1 needs momentum. It is the densest 4 lines in the front-door path.

**Changes:**

1. Show the two startup methods compactly side-by-side with one-line annotations:

   ```bash
   pi --link            # try it now, random name like t-a3f9
   pi-link mybot        # named session you can resume by name
   ```

2. Move the "Why two installs?" callout into a "Notes on installation" subsection at the **bottom** of Quick Start. The information stays available for users who hit the issue, but it stops crowding the entry path.

3. `pi --link-name <name>` stays out of Quick Start — it's a Configuration concern.

_(Rev 2 demoted `pi --link` to a footnote in favor of `pi-link <name>`; opus pushed back — `pi --link` is the lowest-friction try-it-now command and shouldn't be demoted. Folded in.)_

**Risk:** none significant. Both startup paths still visible; install callout is preserved (just moved out of the critical path).

### Phase 2 — Configuration: Naming Concepts subsection + decision table

**Current state:** Configuration is a 5-row "method/when/auto-reconnect" table plus prose. The name story (link name vs Pi session name vs saved `/link-name` vs `--link-name`) is scattered as inline clarifications.

**Changes:**

1. Add a short **Naming Concepts** subsection inside **Configuration**, placed **after the existing lede sentence** ("Link is **off by default**. Without `--link`, `--link-name`, or `pi-link`, the extension is completely silent...") and **before the decision table**. This preserves the lede (the section's most important sentence) AND gives the reader vocabulary for the table rows that follow. (Per `gpt`'s amendment to rev 2: making this a Configuration subsection — not a new top-level section — keeps it less academic, lands at the point of need, and avoids ToC/anchor restructuring. Rev 3 sharpens the placement after both reviewers flagged "top of Configuration" as ambiguous.)

   Four bullets:
   - **link name** — identity used on the network (visible in `link_list`, `/link`, prompts)
   - **Pi session name** — identity Pi gives the session itself; lives in the session JSONL's latest `session_info` entry
   - **saved link name** — the link name persisted to the session, restored on resume. Set by `/link-name`, `pi-link <name>`, or `pi --link-name <name>`.
   - **`--link-name` flag vs `/link-name` command** — same concept (the link name) at different times (startup vs mid-session)

2. Replace the current 5-row table with a decision-framed table:

   ```
   | What you want                          | Use                  |
   | -------------------------------------- | -------------------- |
   | Resume/create a named session          | pi-link <name>       |
   | Stable link identity, normal Pi flow   | pi --link-name <name>|
   | Quick try, random name                 | pi --link            |
   | Already in a session                   | /link-connect        |
   | Disconnect mid-session                 | /link-disconnect     |
   ```

3. Below the table, two short sentences (not the current dense paragraph) preserving the semantic distinction the table can't carry:

   > `pi-link <name>` resumes/creates a session AND sets your link identity in one step. `pi --link-name <name>` sets only the link identity, leaving Pi's normal session selection (latest in cwd, or fresh) untouched.

4. Wrapper-rejection note ("the `pi-link` wrapper itself does not accept `--link-name`") moves to a footnote on the precedence ladder.

5. Drop the Auto-reconnect column — every row in the original table said "Yes" except `/link-disconnect`. The "explicit user intent takes precedence over `--link`" carry-over already lives in the prose paragraph below.

**Precedence ladder stays user-facing terms only:**

> `pi --link-name` > `pi-link <name>` > saved `/link-name` > Pi session name > random `t-xxxx`

No `PI_LINK_NAME` mention.

_(Rev 2 dropped the two-sentence prose entirely; opus pushed back — the decision column flattens the `pi-link <name>` vs `pi --link-name <name>` semantic nuance, which is the most-confused distinction in the doc. Prose stays.)_

**Risk:** the dropped Auto-reconnect column might cause a reader to wonder. Mitigation: prose paragraph below the table still asserts "Explicit user intent takes precedence over `--link`."

### Phase 3 — Top blockquote leads with user value

**Current state:** Top blockquote opens implementation-first ("Self-contained TypeScript in a single `index.ts` file...").

**Changes:**

Lead with user value (what does pi-link DO for me?), then implementation detail can stay as a subordinate clause if it earns its place. Target: 2–3 sentences, value-first.

**Risk:** low. Reframing prose without changing accuracy.

### Phase 4 — Validation

After phases 1–3 land, in this order:

1. **Update the Table of Contents** if any anchors shifted. (Naming Concepts is a subsection of Configuration, so no top-level anchor change is expected.)
2. **Re-read top to bottom as a new reader.** Specifically: does Quick Start get the user running in 60 seconds without the install callout interrupting? Does Configuration tell them which method to pick within the first screen?
3. **Grep validation** — every term below must still be findable in the README (case-insensitive):
   - `--link`, `--link-name`, `--global`, `-g`
   - `pi-link list`, `pi-link resolve`
   - `PI_CODING_AGENT_SESSION_DIR`, `sessionDir`
   - `idle-gated`, `keepalive`, `triggerTurn`
   - `link_prompt`, `link_send`, `link_list`
   - `/link`, `/link-name`, `/link-connect`, `/link-disconnect`, `/link-broadcast`
   - `dedup` or "no-op restart" (the recency note)
4. **Anchor link check** — every internal `[text](#anchor)` resolves. Naming Concepts is new; verify no broken anchors elsewhere.
5. **`PI_LINK_NAME` non-leak check** — confirm the env var name does not appear in user-facing sections (Quick Start, Configuration, Walkthrough, Limitations, Troubleshooting). Allowed: CHANGELOG, `bin/pi-link.mjs`, `index.ts` source comments.
6. **Send to `gpt@pi-link` AND `opus@pi-link` for fresh-eyes review.** (Not `docs@pi-link` — docs is the executor of this plan; same pattern as the rev 1 → rev 2 review.) Treat reviewer issues as correctness bugs.

## Open questions resolved

- **Concepts position:** inside Configuration as opening subsection (revised from rev 2's standalone placement per `gpt` review).
- **Install callout:** moved to "Notes on installation" subsection at bottom of Quick Start (per `docs` review).
- **Plan file fate:** delete after work lands. CHANGELOG carries no entry — this is doc-internal cleanup, not a release-noted change.
- **Deferred phases:** if the deferred phases (Walkthrough rewrite, Internals diet, Limitations cleanup) are still wanted later, write a fresh plan against the post-compression README, not a re-resurrection of rev 2.

## Definition of done

- Phases 1–3 landed in one continuous work pass (~2 hours)
- README reads top-to-bottom without backtracking required for the default path
- Every behavior currently documented is still findable (Phase 4 grep list)
- No `PI_LINK_NAME` in user-facing sections
- All internal anchors resolve
- `gpt@pi-link` + `opus@pi-link` review pass complete with all reviewer issues addressed
- This plan file deleted
- Front-door experience for a new user is meaningfully tighter than before, even if Internals/Walkthrough/Limitations stay as-is
