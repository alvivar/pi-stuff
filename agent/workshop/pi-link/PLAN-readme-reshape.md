# PLAN: README reshape pass

Step-back rewrite of `README.md` to fix accumulated drift from incremental maintenance. Every individual edit over the past year was reasonable; the cumulative shape isn't. This plan addresses six specific issues I can defend, executes them as one continuous work pass with phase descriptions as a thinking checklist (not commit boundaries), and validates with a `gpt@pi-link` review at the end.

This is revision 2 after a `gpt@pi-link` + `opus@pi-link` review pass on revision 1. Convergent reviewer pushbacks have been folded in; divergences are noted at the relevant phase.

## Goals

1. Reader hits the doc and lands on a clear default path within 30 seconds. Advanced options are reachable but don't crowd the entry.
2. The Why section's promised patterns (orchestrator/worker, fan-out) are demonstrated in the Walkthrough.
3. The name story (link name vs Pi session name vs saved `/link-name` vs `--link-name` flag) is decomposed in one place, not scattered as inline clarifications.
4. Internals is contributor-helpful, not exhaustive. Tables that mirror code inventory get cut.
5. Limitations is uniform in concern-level. Subtle-bug edge cases move to Internals with a back-reference.
6. The opening leads with user value, not implementation. Implementation belongs lower.

## Non-goals

- **No content drift.** Every behavior currently documented either stays documented or moves explicitly. Nothing gets silently dropped.
- **No CHANGELOG edits.** History is not cruft.
- **No SKILL.md edits.** Already clean per the latest audit.
- **No new features documented.** This is reshape, not feature work.
- **No section renames.** Anchor links to current sections must continue resolving.
- **No `PI_LINK_NAME` in user-facing precedence ladder or table.** Same principle being applied to the State Management cut: don't surface internal mechanism in user-facing surfaces. Internal handoff stays internal.
- **No length target.** The doc should be as long as it earns. Side-effect, not goal.

## Out of scope (sections not touched)

- Prerequisites — fine as-is
- Slash Commands — recently audited, accurate
- Architecture (Hub-Spoke + Auto-Discovery + Hub Promotion) — accurate, well-shaped
- Troubleshooting — fine as-is
- Dependencies / Provided by Pi / `package.json` block — recently audited, accurate
- Internals → Protocol, Message Flow Examples, Idle-Gated Inbox, Rendering, Agent Lifecycle Integration, Message Routing — keep

If a reviewer flags one of these as having a real issue, that's a separate concern; this plan won't preemptively touch them.

## Phases

Six phases, executed continuously in one work pass. Phase boundaries are for thinking, not commits. Validation is one pass at the end.

### Phase 1 — Concepts glossary (additive)

Add a short **Concepts** section **just before Configuration**, where names start mattering operationally. (Revision 1 placed it between Why and Prerequisites; both reviewers pushed back — a glossary up front is a tone signal that the system is confusing, and it interrupts the running-the-thing path.)

Four bullets:

- **link name** — identity used on the network (visible in `link_list`, `/link`, prompts)
- **Pi session name** — identity Pi gives the session itself; lives in the session JSONL's latest `session_info` entry
- **saved link name** — the link name persisted to the session, restored on resume. Set by `/link-name`, `pi-link <name>`, or `pi --link-name <name>`.
- **`--link-name` flag vs `/link-name` command** — same concept (the link name) at different times (startup vs mid-session)

**Risk:** adds a section that may feel academic on first read. Mitigated by keeping it under 8 lines and placing it where readers have already seen the system run. _(Revision 1 said "Risk: none. Pure addition." — that was wrong. Adding a glossary is a structural decision with tone implications, even if the content is purely additive.)_

**Correctness fix from review:** the "Pi session name" line in revision 1 said the value lives in `session_info.json`. That file does not exist; the source is the latest `session_info` entry in the session JSONL. Fixed above.

### Phase 2 — Quick Start shows both default paths

Quick Start currently shows two startup methods (`pi --link` and `pi-link <name>`). Keep both. Show them compactly side-by-side with one-line annotations, so the reader picks based on whether they care about resume-by-name:

```bash
pi --link            # try it now, random name like t-a3f9
pi-link mybot        # named session you can resume by name
```

`pi --link-name <name>` is **not** in Quick Start. It's a Configuration concern (link-only naming for users who already know they want it).

_(Revision 1 demoted `pi --link` to a footnote in favor of `pi-link <name>` as the showcased path. Opus pushed back: `pi --link` is the lowest-friction "try it now" command and shouldn't be demoted for the marginal benefit of showcasing the recommended path. Folded in.)_

**Risk:** none significant after revision. Both paths visible, reader chooses.

### Phase 3 — Configuration table collapses to a decision

Replace the current 5-row "method/when/auto-reconnect" table with a decision-framed table:

```
| What you want                          | Use                  |
| -------------------------------------- | -------------------- |
| Resume/create a named session          | pi-link <name>       |
| Stable link identity, normal Pi flow   | pi --link-name <name>|
| Quick try, random name                 | pi --link            |
| Already in a session                   | /link-connect        |
| Disconnect mid-session                 | /link-disconnect     |
```

Below the table, **two short sentences** (not the current dense paragraph) name the semantic distinction the table can't carry:

> `pi-link <name>` resumes/creates a session AND sets your link identity in one step. `pi --link-name <name>` sets only the link identity, leaving Pi's normal session selection (latest in cwd, or fresh) untouched.

Wrapper-rejection note ("the `pi-link` wrapper itself does not accept `--link-name`") moves to a footnote on the precedence ladder.

Auto-reconnect column from the current table gets dropped — every row in the original table said "Yes" except `/link-disconnect`. The information that matters ("explicit user intent takes precedence over `--link`") already lives in the prose paragraph below.

**Precedence ladder stays user-facing terms only:**

> `pi --link-name` > `pi-link <name>` > saved `/link-name` > Pi session name > random `t-xxxx`

No `PI_LINK_NAME` mention. The current README already uses this form (line 148); keeping it that way is non-negotiable per the consistency principle both reviewers flagged.

_(Revision 1 dropped the prose paragraph entirely. Opus pushed back: the decision column flattens the `pi-link <name>` vs `pi --link-name <name>` semantic nuance, which is the most-confused distinction in the doc. Two-sentence prose stays.)_

**Risk:** the dropped Auto-reconnect column might cause a reader to wonder. Mitigation: prose paragraph below the table still asserts "Explicit user intent takes precedence over `--link`," which carries the load.

### Phase 4 — Walkthrough demonstrates orchestrator/worker

Replace the current `pi --link` + `/link-name` + single `link_prompt` walkthrough with one that demonstrates orchestrator/worker — the headline pattern from Why.

**Scenario (chosen for simplicity per review):**

Three terminals: `lead`, `researcher`, `reviewer`. User in `lead` asks: _"Ask researcher to summarize `README.md`, and ask reviewer to lint the same file."_ `lead`'s LLM fires two `link_prompt` calls in parallel (different targets, so no busy collision). Both workers return their results. `lead`'s LLM synthesizes and presents.

This demonstrates: orchestrator/worker pattern, parallelism, and fan-out — three things the Why section promises — using **only `link_prompt`** in the main walkthrough.

A separate one-paragraph follow-up (not in the main walkthrough flow) points at `link_send(triggerTurn:true)` + callback contract for fire-and-forget delegation, with a one-line link to the bundled skill for full coordination guidance.

**Constraint:** main walkthrough stays under 30 lines of code/output combined. Walkthroughs that get long stop being read.

_(Revision 1 proposed orchestrator/worker mixing `link_prompt` + `link_send(triggerTurn:true)` + callback contract. Both reviewers pushed back: too much for a first concrete example, mixes two coordination patterns, callback batching is internals-flavored. Folded in: `link_prompt` only in main walkthrough, async/callback as one-paragraph follow-up.)_

**Risk:** harder to keep accurate as the system evolves. Mitigation: the walkthrough uses the public surface (`link_prompt`, parallel tool calls, output synthesis) which is stable.

### Phase 5 — Internals diet

- **Cut the State Management table** (12 rows). Replace with one paragraph naming the load-bearing pieces of state with **specific names and intent**, not decorative inventory:

  > Three pieces of state coordinate the extension: `role` (`"hub" | "client" | "disconnected"`) drives connection behavior, `inbox` queues `triggerTurn:true` chat messages awaiting idle-gated flush, and `pendingPromptResponses` (`Map<requestId, resolver>`) tracks outstanding `link_prompt` RPCs with their inactivity and ceiling timers.

  Other state fields exist; they're load-bearing in narrower contexts and the source has them.

- **Trim Connection Lifecycle** to one sentence on context guards: "WebSocket callbacks are guarded against stale extension context after `session_shutdown`." The three named helpers (`getUi()`, `notify()`, `isRuntimeLive()`) are implementation detail; anyone modifying that path will find them in the source.

- **Keep** Protocol section, Message Flow Examples, Name Uniqueness & Persistence, Idle-Gated Inbox, Agent Lifecycle Integration, Message Routing & Error Handling, Rendering. These describe _behavior and rationale that isn't obvious from code_.

**Sanity check (per review):** this walks back the State Management table I previously argued for. Both reviewers confirmed the cut is consistent with the `PI_LINK_NAME`-out-of-Internals principle (contributor docs describe non-obvious behavior, not code inventory). The original audit gap was "code and docs disagreed on field names"; the fix to that is field-name accuracy in prose, not a table that mirrors source. Not rationalization.

**Risk:** without the table, future code-doc drift on field names re-emerges. Mitigation: the prose names specific fields with their types and intent. A reviewer auditing future drift will compare prose to code, same as before, just against fewer surfaces.

### Phase 6 — Limitations cleanup

- **Move** "Rename during prompt loses keepalives" (current row 8) into Internals → Name Uniqueness & Persistence as a known edge case. It's not the same concern class as "no auth" or "localhost-only."
- **Add a one-line cross-reference** at the bottom of Limitations: _"For the rename-during-prompt edge case, see [Name Uniqueness & Persistence](#name-uniqueness--persistence)."_ Two-way visibility costs nothing and keeps users who grep Limitations for safety considerations from missing the operational nuance.
- **Keep** rows 1–7 unchanged.
- **Sequenced after Phase 5** so Internals is in its final shape before content gets moved into it. _(Revision 1 ordered this before Phase 5; GPT pushed back. Folded in.)_

**Risk:** users grep Limitations specifically when deciding if the system is safe for their use case. Cross-reference handles the discoverability gap.

### Phase 7 — Validation

After phases 1–6 land, in this order:

1. **Update the Table of Contents** to match the final section structure. (Concepts section is the only structural addition; no renames.)
2. **Re-read top to bottom as a new reader.** Specifically: does Quick Start get the user running in 60 seconds? Does Configuration tell them which method to pick without making them read all five rows of prose?
3. **Update the top blockquote.** Currently leans implementation-first ("Self-contained TypeScript in a single `index.ts` file"). Lead with user value; implementation can stay but moves to a sub-clause.
4. **Grep validation** — every term below must still be findable in the README (case-insensitive):
   - `--link`, `--link-name`, `--global`, `-g`
   - `pi-link list`, `pi-link resolve`
   - `PI_CODING_AGENT_SESSION_DIR`, `sessionDir`
   - `idle-gated`, `keepalive`, `triggerTurn`
   - `link_prompt`, `link_send`, `link_list`
   - `/link`, `/link-name`, `/link-connect`, `/link-disconnect`, `/link-broadcast`
   - `dedup` or "no-op restart" (the recency note)
5. **Anchor link check** — every internal `[text](#anchor)` resolves. No section renames per non-goal, but Concepts is new.
6. **`PI_LINK_NAME` non-leak check** — confirm the env var name does not appear in user-facing sections (Quick Start, Configuration, Walkthrough, Limitations, Troubleshooting). It may appear in CHANGELOG (technical history, exempt) and may continue to appear in `bin/pi-link.mjs` and `index.ts` source comments (not README surface).
7. **Send to `gpt@pi-link` for fresh-eyes review.** Treat reviewer issues as correctness bugs.

## Open questions resolved from review

1. **Walkthrough scenario:** orchestrator/worker with two `link_prompt` calls in parallel. Async/callback gets a one-paragraph follow-up, not main-walkthrough billing. (Both reviewers agreed.)
2. **State table:** fully cut. No `<details>` block. (Both reviewers agreed; collapsed blocks invite the same accretion to come back.)
3. **Concepts position:** just before Configuration, where names start mattering operationally. (Both reviewers pushed back on between-Why-and-Prerequisites.)
4. **Plan file fate:** delete after work lands. CHANGELOG carries no entry — this is doc-internal cleanup, not a release-noted change. (Both reviewers agreed.)

## Definition of done

- All six phases landed in one continuous work pass
- README reads top-to-bottom without backtracking required for the default path
- Every behavior currently documented is still findable (Phase 7 grep list)
- No `PI_LINK_NAME` in user-facing sections
- ToC matches final structure; all internal anchors resolve
- `gpt@pi-link` review pass complete with all reviewer issues addressed
- This plan file deleted
- I would describe the result as "the README I'd write from scratch today"
