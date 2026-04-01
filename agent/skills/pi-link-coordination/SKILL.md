---
name: pi-link-coordination
description: Guidance for coordinating work across Pi terminals using pi-link. Use when delegating tasks, choosing between link_prompt and link_send, planning async vs sync work, batching parallel jobs, or avoiding busy/conflict patterns.
---

# Pi-Link Agents Guide

How Pi terminal agents coordinate and collaborate using pi-link.

---

## Tool Selection Rule

- Need the answer back now? → `link_prompt`
- Need autonomous work done? → `link_send(triggerTurn: true)`
- Need to notify only? → `link_send(triggerTurn: false)`

---

## The Golden Rule

> After `link_send(triggerTurn: true)` to terminal X, do not `link_prompt` X until X sends a completion callback.

Pick one mode per terminal per task:

- **Sync:** `link_prompt` → get response → continue
- **Async:** `link_send(triggerTurn: true)` → do your own work → wait for callback

Mixing them on the same terminal is the most common coordination failure.

---

## The Tools

### `link_list`

Discover who's online. Returns all connected terminals with names and live status (`idle`, `thinking`, `tool:bash`, etc.).

**Use when:** Availability is uncertain, before retrying a busy target, or after coordination state changes.

### `link_send`

Fire-and-forget messaging. Send to one terminal or broadcast to all (`to: "*"`).

Set `triggerTurn: true` to make the receiver's LLM act on the message autonomously. The sender does **not** get the response back.

**Completion callback contract:** When delegating with `triggerTurn: true`, ask the receiver to send back via `link_send`:

- `DONE` signal
- Output paths / artifacts created
- Blockers or open questions

### `link_prompt`

Synchronous RPC. Send a prompt, wait for the remote LLM to process it, get the full response back.

**Behavior:**

- Prompts to yourself are rejected immediately
- If the target is missing or unreachable, fails immediately
- If the target is already busy (local work or another remote prompt), rejected as busy
- Times out after 90s of target silence, with a 30min hard ceiling
- Fails immediately if the target disconnects

**Prompt checklist** — every remote prompt should include:

- **Goal:** what you need
- **Scope:** which files, paths, topics
- **Constraints:** format, length, style, what to avoid
- **Output format:** how to structure the response
- **Done condition:** when the task is complete

The remote agent doesn't share your conversation context. Make every prompt self-contained.

---

## Naming Convention

Terminal names use `role@domain` format (e.g., `builder@pi-link`). Use the full name as shown by `link_list`. Only communicate with terminals in your own domain unless instructed otherwise.

---

## Operating Constraints

- **One remote prompt at a time per target.** Concurrent requests are rejected as busy.
- **No shared conversation context.** Remote prompts must be self-contained.
- **Broadcast excludes sender.** `link_send(to: "*")` delivers to all other terminals.
- **Messages are ephemeral.** If a terminal is offline, the message is lost.
- **Localhost only.** Pi-link connects terminals on the same machine.

---

## Coordination Patterns

### 1. Orchestrator / Worker

One agent coordinates, others execute focused tasks. The orchestrator decomposes work, delegates via `link_prompt`, and synthesizes results.

**Use when:** Clear hierarchy, one agent holds full context.
**Tools:** `link_prompt` for delegation, `link_list` before each call.
**Caution:** Don't overload one worker sequentially — batch or distribute.

### 2. Research + Build

One agent investigates (docs, APIs, analysis), another builds based on findings.

**Use when:** New territory — understand before building.
**Tools:** `link_prompt` to researcher, then `link_prompt` to builder with findings.

### 3. Review Pipeline

Iterative: builder implements → reviewer critiques → builder fixes → reviewer re-reviews.

**Use when:** Quality matters — APIs, security-sensitive code, documentation.
**Tools:** Sequential `link_prompt` calls coordinated by orchestrator.
**Caution:** Keep review scope focused to avoid timeout.

### 4. Parallel Fan-Out

Distribute independent tasks across multiple agents using `link_send(triggerTurn: true)` with file output. Each agent writes results to agreed-upon paths. Wait for DONE callbacks, then synthesize.

**Use when:** Independent tasks that don't depend on each other's output.
**Tools:** `link_send(triggerTurn: true)` per agent, explicit file paths.
**Caution:** Use explicit paths (absolute when needed). Require DONE callbacks. Don't `link_prompt` agents you just dispatched.

### 5. Notification / Steering

Inform agents without blocking — status broadcasts, context changes, steering idle agents to start work.

**Use when:** Coordination messages that don't need a response.
**Tools:** `link_send(triggerTurn: false)` for info, `link_send(triggerTurn: true)` to steer.

### 6. Builder / Critic

One builds a draft, the other critiques structurally without rewriting. Focused feedback, not a full rewrite.

**Use when:** Draft exists and needs targeted improvement.
**Tools:** `link_prompt` to critic with specific review criteria.

### 7. Spec Lock + Batch Jobs

Agree on a contract (structure, glossary, conventions) before anyone writes. Then each agent executes independently.

**Use when:** Multiple parallel artifacts that must be consistent.
**Tools:** `link_prompt` for spec agreement, then `link_send(triggerTurn: true)` for batch execution.
**Caution:** Lock the spec first — inconsistency is expensive to fix later.

---

## Recommended Workflow

### Step 1 — Discovery

`link_list` → see who's available.

### Step 2 — Spec Lock

Agree on: objective, file structure, naming, conventions, ownership per artifact, definition of done.

### Step 3 — Execute

Choose one mode per terminal:

**Direct file output** (more efficient):

```
link_send(triggerTurn: true):
  "Write [files] to [explicit paths]. [Constraints]. Send DONE + file list when finished."
```

Use explicit paths (absolute when needed) — the remote agent doesn't share your mental model of the workspace. Do your own work in parallel.

**Prompt-and-receive** (more control):

```
link_prompt: "Write the content for [section]. Include [details]."
```

Review before saving. Better for quality-sensitive work.

### Step 4 — Completion

Require explicit signals: DONE + artifact list + blockers.

### Step 5 — Cross-Review

Each agent reviews the other's output for consistency, gaps, and quality.

### Step 6 — Final Pass

One unified pass: terminology, formatting, cross-references, naming.

---

## Anti-Patterns

**❌ Mixing async and sync on the same terminal**
`link_send(triggerTurn: true)` then `link_prompt` → rejected as busy. Pick one mode. (See Golden Rule.)

**❌ Using `link_send` when you need the response**
The result disappears. If you need text back, use `link_prompt`.

**❌ Vague prompts to remote agents**
"Fix the bug" → useless. Include file, line, root cause, expected fix. Self-contained.

**❌ No completion callback on async work**
Always ask for `DONE` + artifact paths + blockers via `link_send`.

**❌ Overloading one agent sequentially**
Batch related tasks or distribute across available agents.

**❌ Circular delegation**
A → B → C → A = deadlock. Maintain clear hierarchy.

**❌ Skipping `link_list` before retrying busy targets**
Check status before re-sending to a target that previously rejected you.

---

## Lessons Learned

From real multi-agent collaboration producing 7 documents (~144 KB):

- Don't warm up with `link_send(triggerTurn: true)` if your next step needs `link_prompt` — the target will be busy
- Batch independent work into single delegations, not sequential micro-tasks
- Always require explicit DONE callbacks on async work
- Define ownership and protocol in the first exchange
- Cross-review after all writing is complete, not during

---

## Quick Reference

| I need to...                     | Tool                            | Mode            |
| -------------------------------- | ------------------------------- | --------------- |
| See who's available              | `link_list`                     | —               |
| Get an answer from another agent | `link_prompt`                   | Synchronous     |
| Delegate autonomous work         | `link_send(triggerTurn: true)`  | Asynchronous    |
| Notify without activating        | `link_send(triggerTurn: false)` | Fire-and-forget |
| Broadcast to all                 | `link_send(to: "*")`            | Broadcast       |
