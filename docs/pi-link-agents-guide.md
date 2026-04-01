# Pi-Link Agents Guide

How Pi terminal agents coordinate and collaborate using pi-link.

Born from real multi-agent collaboration experience. This guide covers tool selection, coordination patterns, workflow, and the mistakes we've made so you don't repeat them.

---

## Tool Selection Rule

- Need the answer back now? → `link_prompt`
- Need autonomous work done? → `link_send(triggerTurn: true)`
- Need to notify only? → `link_send(triggerTurn: false)`

---

## The Tools

### `link_list`

Discover who's online. Returns all connected terminals with names and live status.

| Parameter | Type | Description         |
| --------- | ---- | ------------------- |
| _(none)_  | —    | Takes no parameters |

**Returns:** Terminal directory with status per agent — `idle (2m)`, `thinking (3s)`, `tool:bash (12s)`.

**Use when:** Before delegating. Always.

---

### `link_send`

Fire-and-forget messaging. Send to one terminal or broadcast to all.

| Parameter     | Type      | Required | Description                                                    |
| ------------- | --------- | -------- | -------------------------------------------------------------- |
| `to`          | `string`  | Yes      | Target terminal name, or `"*"` for broadcast                   |
| `message`     | `string`  | Yes      | Message content                                                |
| `triggerTurn` | `boolean` | No       | If `true`, the receiver's LLM acts on the message autonomously |

**Returns:** Delivery confirmation only — not the receiver's response.

**Use when:**

- Notifying agents of events, context changes, completion
- Steering an agent to start autonomous work (`triggerTurn: true`)
- Broadcasting status or announcements

**Completion callback contract:** When delegating autonomous work with `triggerTurn: true`, explicitly ask the receiver to report back with:

- `DONE` signal
- Output paths / artifacts created
- Blockers or open questions

---

### `link_prompt`

Synchronous RPC. Send a prompt, wait for the remote LLM to process it, get the full response back.

| Parameter | Type     | Required | Description          |
| --------- | -------- | -------- | -------------------- |
| `to`      | `string` | Yes      | Target terminal name |
| `prompt`  | `string` | Yes      | Prompt text to send  |

**Returns:** The remote terminal's complete assistant response.

**Use when:** You need the other agent's answer to continue your own work — research results, code review feedback, generated content, analysis.

**Behavior:**

- Prompts to yourself are rejected immediately
- If the target is missing or unreachable, the call fails immediately
- If the target is already running a prompt, it's rejected as busy
- Inactivity timeout: 90 seconds of silence from the target
- The target sends keepalives while working, so long tasks don't false-timeout
- Hard ceiling: 30 minutes (safety net)
- Immediate failure if the target disconnects

**Prompt checklist** — every prompt to a remote agent should include:

- **Goal:** what you need
- **Scope:** which files, paths, topics
- **Constraints:** format, length, style, what to avoid
- **Output format:** how to structure the response
- **Done condition:** when the task is complete

The remote agent doesn't share your conversation context. Make every prompt self-contained.

---

## Decision Flowchart

```
Do I need the response to continue my work?
│
├─ NO
│  └─ Use link_send
│      ├─ Just informing / coordinating? → triggerTurn: false
│      └─ Delegating autonomous work?    → triggerTurn: true
│                                           (include callback contract)
│
└─ YES
   └─ First: link_list
       ├─ Target is idle?  → link_prompt
       └─ Target is busy?  → wait / reassign / do it locally
```

**Complementary rule:** If you delegated a job with `link_send(triggerTurn: true)`, assume that terminal is busy until it signals completion. Don't follow up with `link_prompt` immediately.

---

## The Golden Rule

> **Don't mix async and sync on the same terminal.**

If you sent `link_send(triggerTurn: true)` to a terminal, that terminal is now working autonomously. Don't immediately follow up with `link_prompt` — it will get rejected as busy.

Pick one mode per terminal per task:

- **Sync:** `link_prompt` → get response → continue
- **Async:** `link_send(triggerTurn: true)` → do your own work → wait for completion callback

This is the single most common coordination failure. It happened to us in real collaboration and caused wasted round-trips and blocked workflows.

---

## Naming Convention

Terminal names follow the pattern `role@domain`:

- **role** — the agent's function (`builder`, `reviewer`, `planner`, `docs`)
- **domain** — the project or scope (`pi-link`, `my-app`, `user`)

Examples:

```
builder@pi-link     — writes code for pi-link
reviewer@pi-link    — reviews code for pi-link
planner@my-app      — plans features for my-app
```

Use the full terminal name as shown by `link_list`. Only communicate with terminals in your own domain unless instructed otherwise.

---

## Operating Constraints

These are system facts, not suggestions:

- **One remote prompt at a time per target.** Concurrent `link_prompt` requests to the same terminal are immediately rejected with "Terminal is busy".
- **No shared conversation context.** Each agent has its own history. Remote prompts must be self-contained.
- **Broadcast excludes sender.** `link_send(to: "*")` delivers to all other terminals, not back to you.
- **Messages are ephemeral.** WebSocket frames — if a terminal is offline, the message is lost.
- **Localhost only.** Pi-link connects terminals on the same machine.
- **Hub-spoke topology.** All messages route through the hub. Hub loss triggers promotion, which can drop in-flight state.

---

## Coordination Patterns

### 1. Discovery First

Always check who's available before delegating.

```
1. link_list → see who's online and their status
2. Pick idle targets for work
3. Avoid sending to busy terminals
```

**Use when:** Always, before any delegation.

### 2. Orchestrator / Worker

One agent coordinates, others execute. The orchestrator decomposes work, delegates, and synthesizes results.

```
orchestrator:
  1. link_list → planner is idle, builder is idle
  2. link_prompt → planner: "Design the auth system..."
  3. Receives plan
  4. link_prompt → builder: "Implement this plan: [details]"
  5. Receives confirmation
  6. link_prompt → reviewer: "Review the implementation..."
  7. Synthesizes and reports to user
```

**Use when:** Clear hierarchy, one agent holds full context, others do focused work.

### 3. Research + Build

Split investigation from implementation. One agent explores, another builds based on findings.

```
orchestrator:
  1. link_prompt → planner: "Research the Stripe API for subscriptions..."
  2. Receives research
  3. link_prompt → builder: "Implement billing using these findings: [research]"
```

**Use when:** New territory — you need to understand before you build.

### 4. Review Pipeline

Iterative feedback loop between builder and reviewer.

```
orchestrator:
  1. link_prompt → builder: "Implement user registration"
  2. link_prompt → reviewer: "Review the registration endpoint"
  3. If issues → link_prompt → builder: "Fix these: [feedback]"
  4. If issues → link_prompt → reviewer: "Re-review the fixes"
  5. Repeat until approved
```

**Use when:** Quality matters — documentation, APIs, security-sensitive code.

### 5. Fan-Out

Distribute independent tasks across multiple agents.

**Sequential** (using `link_prompt`):

```
orchestrator:
  1. link_prompt → planner: "Analyze the schema"
  2. link_prompt → builder: "List all API endpoints"
  3. link_prompt → reviewer: "Check test coverage"
  4. Synthesize results
```

**Parallel** (using `link_send` + file output):

```
orchestrator:
  1. link_send → agent-a: "Write analysis to docs/schema.md" (triggerTurn: true)
  2. link_send → agent-b: "Write inventory to docs/api.md" (triggerTurn: true)
  3. Write own docs in parallel
  4. Wait for DONE callbacks, then synthesize
```

**Use when:** Independent tasks that don't depend on each other's output.

### 6. Notification / Steering

Inform agents without blocking.

```
link_send → "*": "Phase 1 complete. Moving to Phase 2."  (triggerTurn: false)
link_send → builder: "Start on the payment module"        (triggerTurn: true)
link_send → "*": "CI is broken. Don't merge until fixed." (triggerTurn: false)
```

**Use when:** Coordination messages, context updates, status broadcasts.

### 7. Builder / Critic

One builds, the other critiques structurally without rewriting.

```
builder writes draft → saves to file
link_prompt → critic: "Review [file] for structure, gaps, tone. Don't rewrite — list issues."
builder applies fixes based on feedback
```

**Use when:** Draft exists and needs improvement, not a full rewrite.

### 8. Spec Lock + Batch Jobs

Agree on a contract (structure, glossary, conventions) before anyone writes. Then each agent executes independently without drifting.

```
orchestrator:
  1. link_prompt → worker: "Propose document structure, naming conventions, tone"
  2. Agree on spec
  3. link_send → worker: "Write docs 01/02/03 following the spec. DONE when finished." (triggerTurn: true)
  4. Orchestrator writes docs 04/05/06 in parallel
  5. Wait for DONE, then cross-review
```

**Use when:** Producing multiple parallel artifacts that must be consistent (docs, configs, test suites).

---

## Recommended Workflow

A general workflow for multi-agent collaboration on any substantial task.

### Step 1 — Discovery

```
link_list → see who's available
```

### Step 2 — Spec Lock

Agree before producing:

- Objective and scope
- File structure and naming
- Conventions (format, tone, terminology)
- Ownership — who produces what
- Definition of done

### Step 3 — Ownership Assignment

Explicitly assign what each terminal produces. No ambiguity.

### Step 4 — Execute

Choose one mode per terminal:

**Option A — Direct file output** (more efficient):

```
link_send(triggerTurn: true):
  "Write [files] to [paths]. [Constraints]. Send DONE when finished."
```

Use explicit absolute paths or agree on workspace conventions upfront — the remote agent doesn't know your mental model of "the project folder."

Meanwhile, do your own work in parallel.

**Option B — Prompt-and-receive** (more control):

```
link_prompt: "Write the content for [section]. Include [details]."
```

Review before saving. Better for quality-sensitive work.

### Step 5 — Completion Callback

Always require explicit completion signals:

- DONE + list of artifacts
- Open questions or blockers
- Anything that deviates from the spec

### Step 6 — Cross-Review

Each agent reviews the other's output:

- Consistency with spec
- Quality, gaps, tone
- Cross-references between artifacts

### Step 7 — Final Consistency Pass

One unified pass to catch:

- Terminology drift
- Format inconsistencies
- Broken cross-references
- Naming mismatches

---

## Anti-Patterns

### ❌ Sending work without checking availability

```
# Bad: might get "Terminal is busy"
link_prompt → builder: "Do this task"

# Good: check first
link_list → builder is idle → link_prompt → builder: "Do this task"
```

### ❌ Using `link_send` when you need the response

```
# Bad: result disappears into the void
link_send → planner: "What's the best architecture?" (triggerTurn: true)

# Good: use link_prompt
link_prompt → planner: "What's the best architecture?"
```

### ❌ Mixing async and sync on the same terminal

```
# Bad: worker is now busy from the send
link_send → builder: "Start working on auth" (triggerTurn: true)
link_prompt → builder: "What's the auth status?"  ← REJECTED: busy

# Good: pick one mode
link_prompt → builder: "Implement auth and report what you did"
```

This is the most common failure mode. See the Golden Rule.

### ❌ Vague prompts to remote agents

```
# Bad: remote agent lacks context
link_prompt → builder: "Fix the bug"

# Good: self-contained
link_prompt → builder: "Null pointer in src/api/users.ts:42.
  The user object can be undefined when the query returns no results.
  Add a null check before accessing user.email."
```

### ❌ Overloading one agent sequentially

```
# Bad: bottleneck
link_prompt → builder: task 1, then task 2, then task 3, then task 4

# Better: batch or distribute
link_prompt → builder: "Do tasks 1 and 2"
link_prompt → reviewer: "Do task 3"  (if capable)
```

### ❌ Circular delegation

```
# Bad: deadlock
A → B: "Ask C what to do"
B → C: "Ask A what to do"

# Good: clear hierarchy
orchestrator → planner: "Design it"
orchestrator → builder: "Build this plan: [details]"
```

### ❌ No completion callback on async work

```
# Bad: no way to know when worker is done
link_send → worker: "Write the docs" (triggerTurn: true)
# ...silence...

# Good: explicit contract
link_send → worker: "Write docs to /docs/. When done, send me DONE + file list." (triggerTurn: true)
```

---

## Lessons Learned

From real multi-agent collaboration (two agents producing a 7-document, ~144 KB Game Design Document using pi-link).

### What worked ✅

- `link_list` at the start for discovery
- Natural orchestrator/worker pattern
- `link_prompt` for content that needed to come back
- Self-contained prompts with structure, sections, and expected format
- Real parallel work: one agent wrote while the other generated
- Clear ownership per document — no conflicts

### What failed ❌

- Opening with `link_send(triggerTurn: true)` as a greeting — left the worker busy
- Immediately following up with `link_prompt` — rejected as busy
- Requesting 4 documents sequentially when they could have been batched
- No explicit completion callback protocol
- Not checking `link_list` before each `link_prompt`

### What we'd do differently 🎯

1. Go straight to `link_prompt` for the first exchange — no warm-up `link_send`
2. Define ownership and protocol in the first message
3. Delegate full batches with direct file output
4. Always require a DONE callback
5. Cross-review after all writing is complete
6. Final consistency pass before delivery

---

## Quick Reference

| I need to...                     | Tool                              | Mode            |
| -------------------------------- | --------------------------------- | --------------- |
| See who's available              | `link_list`                       | —               |
| Get an answer from another agent | `link_prompt`                     | Synchronous     |
| Delegate autonomous work         | `link_send(triggerTurn: true)`    | Asynchronous    |
| Notify without activating        | `link_send(triggerTurn: false)`   | Fire-and-forget |
| Broadcast to all                 | `link_send(to: "*")`              | Broadcast       |
| Review another agent's work      | `link_prompt` with specific scope | Review pipeline |
