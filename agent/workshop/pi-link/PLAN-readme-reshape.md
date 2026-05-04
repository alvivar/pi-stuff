# PLAN: README reshape pass

Step-back rewrite of `README.md` to fix accumulated drift from incremental maintenance. Every individual edit over the past year was reasonable; the cumulative shape isn't. This plan addresses six specific issues I can defend, in an order that lets each phase be reviewed and reverted independently.

## Goals

1. Reader hits the doc and lands on a **clear default path** within 30 seconds. Advanced options are reachable but don't crowd the entry.
2. The **Why** section's promised patterns (orchestrator/worker, fan-out) are actually demonstrated in the Walkthrough.
3. The **name story** (link name vs Pi session name vs saved `/link-name` vs `--link-name` flag) is decomposed in one place, not scattered as clarifications.
4. **Internals** is contributor-helpful, not exhaustive. State tables that exist because I made them exist get cut.
5. **Limitations** is uniform in concern-level. Subtle-bug edge cases move to Internals or get cut.
6. Length drops from 623 lines to ~450–500 without losing real information. Numbers are a side-effect, not a target.

## Non-goals

- **No content drift.** Every behavior currently documented either stays documented or moves explicitly. Nothing gets silently dropped.
- **No CHANGELOG edits.** History is not cruft.
- **No SKILL.md edits.** Already clean per the latest audit.
- **No new features documented.** This is reshape, not feature work.
- **No section-renaming for taste alone.** Section renames only when they fix a real reader confusion.

## Phases

Each phase produces a self-contained diff. After each phase, the README still reads correctly — it's not a "halfway through a refactor" state at any commit boundary.

### Phase 1 — Concepts glossary (additive)

Add a short **Concepts** section between Why and Prerequisites:

- `link name` — the identity a terminal uses on the network (visible in `link_list`, `/link`, prompts)
- `Pi session name` — what Pi calls the session itself; lives in `~/.pi/agent/sessions/<id>/session_info.json`
- `saved link name` — value persisted via `/link-name` slash command; restored on session resume
- `--link-name` flag vs `/link-name` command — same concept (the link name) at different times (startup vs mid-session)

Six lines, four bullets. Lets later sections stop redefining these inline.

**Risk:** none. Pure addition.

### Phase 2 — Quick Start owns the default path

Quick Start currently shows two startup methods (`pi --link` and `pi-link <name>`). Trim to **one** showcased path: `pi-link <name>`. It's what most users want and the only path that gives them a stable identity + session resume in one shot.

`pi --link` (random name) becomes a one-line footnote: *"Just want to try it without naming? `pi --link` works too."*

`pi --link-name <name>` is **not** mentioned in Quick Start. It's a Configuration concern (link-only naming for users who already know they want it).

**Risk:** demoting `pi --link` to a footnote could feel like a downgrade for users who currently use it. Mitigation: it's still in the Configuration table, just not the front door.

### Phase 3 — Configuration table collapses to a decision

Current table: 5 rows, all variations on "different ways to start with link enabled." Collapse to a **decision** framing:

```
| What you want                          | Use                  |
| -------------------------------------- | -------------------- |
| Resume/create a named session          | pi-link <name>       |
| Stable link identity, normal Pi flow   | pi --link-name <name>|
| Quick try, random name                 | pi --link            |
| Already in a session                   | /link-connect        |
| Disconnect mid-session                 | /link-disconnect     |
```

Drop the prose paragraph that distinguishes the three startup methods — the "What you want" column does that work. Keep the precedence ladder (it's load-bearing for the rare reader who hits a name conflict).

**Risk:** the wrapper-rejection note ("the `pi-link` wrapper itself does not accept `--link-name`") loses its current home. Move it to a footnote on the precedence ladder, where it's actually relevant.

### Phase 4 — Walkthrough delivers on the Why

Replace the current `pi --link` + `/link-name` + single `link_prompt` walkthrough with one that demonstrates **orchestrator/worker** — the pattern Why headlines.

Concrete scenario: orchestrator terminal asks worker to summarize a file via `link_prompt`, then asks a second worker (in parallel) to lint a different file via `link_send(triggerTurn:true)` with a callback contract. Sender does its own work in the meantime; workers' callbacks batch in on the next idle turn.

This is more lines than the current walkthrough, but it earns them — it's the doc's chance to show what the system is actually for. Current walkthrough doesn't.

**Risk:** harder to keep accurate as the system evolves. Mitigation: the walkthrough uses the public surface (`link_prompt`, `link_send`, `/link-name`) which is stable.

### Phase 5 — Internals diet

- **Cut the State Management table** (12 rows). Anyone modifying the extension has the source; the table doesn't add insight, just inventory. Replace with one paragraph naming the three load-bearing pieces of state (`role`, `inbox`, `pendingPromptResponses`) and what they coordinate.
- **Keep** Protocol section, Message Flow Examples, Name Uniqueness & Persistence, Idle-Gated Inbox, Connection Lifecycle. These describe *behavior* that isn't obvious from code.
- **Trim** Connection Lifecycle: it currently lists three context-guard helpers (`getUi`, `notify`, `isRuntimeLive`). Collapse to one sentence: "WebSocket callbacks are guarded against stale extension context after `session_shutdown`." Helpers are an implementation detail.

**Risk:** I lose ground I previously fought to establish. Specifically, the State Management table came from a real audit gap. Mitigation: the gap was "code and docs disagreed on field names." Solution to *that* is field-name accuracy in the prose, not a table that mirrors the source.

### Phase 6 — Limitations cleanup

- **Move** "Rename during prompt loses keepalives" (row 8) into Internals → Name Uniqueness & Persistence as a known edge case. It's not the same kind of concern as "no auth."
- **Keep** rows 1–7. They're real architectural limitations a user should know.
- **No reordering** beyond the move.

**Risk:** users who currently grep "Limitations" for the keepalive edge case won't find it. Mitigation: it's still in the doc, just in the section that describes the rename mechanism. A reader looking for rename behavior is more likely to land there than in Limitations.

### Phase 7 — Validation

After phases 1–6 land:

1. Re-read top to bottom as a new reader. Specifically: does Quick Start get me running in 60 seconds? Does Configuration tell me which method to pick without making me read all five?
2. Diff against the current README and confirm no shipped behavior went undocumented. Use `grep` for terms like `--global`, `PI_CODING_AGENT_SESSION_DIR`, `idle-gated`, `keepalive`, `dedup`, `triggerTurn` — every one should still be findable.
3. Check that all internal anchor links still resolve. Section renames break `#anchor` links.
4. Send to `gpt@pi-link` for a fresh-eyes review pass. Treat reviewer issues as correctness bugs, per established practice.

## Sequencing notes

- Phases 1–6 are **independent** in the sense that each can land on its own. Phase 1 (Concepts) is additive, so it can land first with no downstream coupling.
- Phases 2 and 3 are **coupled**: Quick Start's trim only works if Configuration's decision table catches the demoted methods. Land them together.
- Phase 4 (Walkthrough) and Phase 5 (Internals) are **independent** of each other and of 2/3.
- Phase 6 (Limitations) is **independent** of all others.

Suggested order: 1 → (2+3) → 6 → 4 → 5 → 7. This puts the lowest-risk additive change first, the most reader-visible improvements (Quick Start + Configuration decision) second, the easy cleanup (Limitations) third, and the larger writes (Walkthrough, Internals) last when I have the most context loaded.

## Open questions for the user

1. **Walkthrough scenario approval.** The orchestrator/worker scenario described in Phase 4 is a draft. If you'd rather see a different pattern demonstrated (review-pipeline, fan-out, parallel-batch), say so before I start writing it.
2. **State Management table fully cut, or kept in a collapsed `<details>` block?** I lean fully cut. A collapsed block invites the same accretion to come back over time.
3. **Concepts section position.** I propose between Why and Prerequisites. Alternative: as a final subsection of Why ("What you'll see in this doc"). The first is more discoverable; the second is less of a structural addition.
4. **Should this plan ship as `PLAN-readme-reshape.md` (this file) and stay in the repo, or get deleted after the work lands?** Other PLAN files in workshop seem to get pruned when DONE. I'd default to that pattern: keep until done, prune after, CHANGELOG carries the user-facing summary if any.

## Definition of done

- All six phases landed
- README reads top-to-bottom without backtracking required for the default path
- Every behavior currently documented is still findable
- `gpt@pi-link` review pass complete with all reviewer issues addressed
- Plan file deleted (per question 4 default)
- I would describe the result as "the README I'd write from scratch today" rather than "what a year of edits accumulated to"
