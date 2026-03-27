# Pi Link: Agent Coordination Guide

How agents use `link_send`, `link_prompt`, and `link_list` to coordinate and work together.

---

## Table of Contents

- [The Tools](#the-tools)
- [Naming Convention](#naming-convention)
- [Coordination Patterns](#coordination-patterns)
  - [1. Discovery First](#1-discovery-first)
  - [2. Orchestrator / Worker](#2-orchestrator--worker)
  - [3. Research + Build](#3-research--build)
  - [4. Review Pipeline](#4-review-pipeline)
  - [5. Fan-Out](#5-fan-out)
  - [6. Notification / Steering](#6-notification--steering)
- [Tool Selection Guide](#tool-selection-guide)
- [Communication Protocols](#communication-protocols)
  - [Structured Requests](#structured-requests)
  - [Status Reporting](#status-reporting)
  - [Error Handling](#error-handling)
- [Constraints & Rules](#constraints--rules)
- [Anti-Patterns](#anti-patterns)
- [Examples](#examples)
  - [Orchestrator delegates a plan](#orchestrator-delegates-a-plan)
  - [Builder asks reviewer for feedback](#builder-asks-reviewer-for-feedback)
  - [Broadcast a status update](#broadcast-a-status-update)

---

## The Tools

Agents have three link tools available:

### `link_list`

**Discover who's online.** Returns all connected terminals with their names, roles, and live status.

| Parameter | Type | Description         |
| --------- | ---- | ------------------- |
| _(none)_  | —    | Takes no parameters |

**Returns:** Terminal directory with status per agent:

- `idle (2m)` — waiting for input
- `thinking (3s)` — LLM is generating
- `tool:bash (12s)` — running a specific tool

**Use when:** You need to know who's available before delegating work, or to check if a target agent is busy.

---

### `link_send`

**Fire-and-forget messaging.** Send a message to one terminal or broadcast to all. Optionally trigger the receiver's LLM to respond autonomously.

| Parameter     | Type      | Required | Description                                                        |
| ------------- | --------- | -------- | ------------------------------------------------------------------ |
| `to`          | `string`  | Yes      | Target terminal name, or `"*"` for broadcast                       |
| `message`     | `string`  | Yes      | Message content                                                    |
| `triggerTurn` | `boolean` | No       | If `true`, the receiver's LLM processes the message and acts on it |

**Returns:** Delivery confirmation only — **not** the receiver's response.

**Use when:**

- Notifying agents of events ("build complete", "deploy started")
- Steering an agent to do something without needing the result back
- Broadcasting status to the whole network

**Key detail:** `triggerTurn: true` makes the remote LLM act on the message autonomously. The remote agent works on its own — the sender doesn't see the response. This is fundamentally different from `link_prompt`.

---

### `link_prompt`

**Synchronous RPC.** Send a prompt to a remote terminal, wait for its LLM to process it, and get the full response back.

| Parameter | Type     | Required | Description          |
| --------- | -------- | -------- | -------------------- |
| `to`      | `string` | Yes      | Target terminal name |
| `prompt`  | `string` | Yes      | Prompt text to send  |

**Returns:** The remote terminal's complete assistant response.

**Use when:** You need the other agent's answer to continue your own work — research results, code review feedback, generated code, analysis, etc.

**Constraints:**

- 2-minute timeout
- One prompt at a time per target (concurrent requests get `"Terminal is busy"`)
- No broadcast mode — targets one terminal at a time

---

## Naming Convention

Terminal names follow the pattern `role@domain`:

- **role** — the agent's function (e.g., `planner`, `builder`, `reviewer`, `orchestrator`)
- **domain** — the project or scope the agent belongs to (e.g., `adaptive-bop`, `user`)

Examples:

```
orchestrator@user       — the user's coordinator agent
planner@adaptive-bop    — plans solutions for the adaptive-bop project
builder@adaptive-bop    — writes code for adaptive-bop
reviewer@adaptive-bop   — reviews code for adaptive-bop
```

When using link tools, use the **full terminal name** as shown by `link_list` (e.g., `builder@adaptive-bop`).

---

## Coordination Patterns

### 1. Discovery First

**Always check who's available before delegating.** Call `link_list` to see which agents are online and what they're doing.

```
Orchestrator:
  1. link_list → sees planner (idle), builder (thinking), reviewer (idle)
  2. Knows builder is busy → delegates to planner first
```

**Why it matters:** Sending a `link_prompt` to a busy agent returns `"Terminal is busy"`. Check status first to avoid wasted calls.

---

### 2. Orchestrator / Worker

One agent coordinates, others execute. The orchestrator decomposes work, delegates via `link_prompt`, and synthesizes results.

```
User → orchestrator@user: "Add authentication to the API"

orchestrator:
  1. link_list → check who's available
  2. link_prompt → planner: "Design an auth system for the API. Consider JWT tokens, middleware patterns, and database schema."
  3. Receives plan from planner
  4. link_prompt → builder: "Implement this auth plan: [plan details]"
  5. Receives code confirmation from builder
  6. link_prompt → reviewer: "Review the auth implementation in src/auth/. Check for security issues."
  7. Receives review feedback
  8. If issues found → link_prompt → builder: "Fix these issues: [feedback]"
  9. Reports final result to user
```

**Key principle:** The orchestrator holds the full context. Workers receive focused, self-contained prompts and return results. The orchestrator decides what to do next based on responses.

---

### 3. Research + Build

Split investigation from implementation. One agent explores (docs, APIs, logs), another writes code based on findings.

```
orchestrator:
  1. link_prompt → planner: "Research the Stripe API for subscription billing. What endpoints do we need? What's the auth flow? Show example payloads."
  2. Receives research summary
  3. link_prompt → builder: "Using the Stripe API, implement subscription billing. Here's what planner found: [research]. Create the service in src/billing/."
  4. Receives implementation confirmation
```

---

### 4. Review Pipeline

Iterative feedback loop between builder and reviewer, coordinated by the orchestrator.

```
orchestrator:
  1. link_prompt → builder: "Implement the user registration endpoint"
  2. link_prompt → reviewer: "Review the registration endpoint the builder just created"
  3. If reviewer finds issues:
     link_prompt → builder: "Reviewer found these issues: [feedback]. Please fix them."
     link_prompt → reviewer: "Builder addressed your feedback. Please re-review."
  4. Repeat until reviewer approves
  5. Report to user: "Registration endpoint implemented and reviewed. [summary]"
```

---

### 5. Fan-Out

Distribute independent tasks across multiple agents simultaneously. Since `link_prompt` is sequential (one at a time per target), fan-out requires either:

**Option A: Sequential fan-out** (using `link_prompt`)

```
orchestrator:
  1. link_prompt → planner: "Analyze the database schema"
  2. link_prompt → builder: "List all API endpoints and their status"
  3. link_prompt → reviewer: "Check test coverage"
  4. Synthesize all three results
```

**Option B: Parallel fire-and-forget** (using `link_send` with `triggerTurn`)

```
orchestrator:
  1. link_send → planner: "Analyze the database schema and save results to docs/schema-analysis.md" (triggerTurn: true)
  2. link_send → builder: "List all API endpoints to docs/api-inventory.md" (triggerTurn: true)
  3. link_send → reviewer: "Write test coverage report to docs/test-coverage.md" (triggerTurn: true)
  4. Wait / poll for file outputs, then synthesize
```

Option B is faster but lossy — you don't get responses back directly. Agents must write results to agreed-upon locations (files, etc.).

---

### 6. Notification / Steering

Use `link_send` to inform agents without blocking or needing a response.

```
# Notify all agents of a context change
link_send → "*": "The main branch was just rebased. Pull latest before making changes."

# Steer an idle agent to start working
link_send → builder: "Start working on the payment module when you're free" (triggerTurn: true)

# Alert about a blocking issue
link_send → "*": "CI is broken on main. Don't merge until fixed."
```

---

## Tool Selection Guide

| I need to...                                      | Use                                       | Why                                            |
| ------------------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| Check who's online and their status               | `link_list`                               | See available agents before delegating         |
| Get an answer from another agent                  | `link_prompt`                             | Synchronous — you get the response back        |
| Tell an agent to do something (don't need result) | `link_send` + `triggerTurn: true`         | Fire-and-forget, agent works autonomously      |
| Notify all agents of something                    | `link_send` to `"*"`                      | Broadcast, informational                       |
| Delegate and wait for completion                  | `link_prompt`                             | The only way to get the result in your context |
| Run parallel independent tasks                    | `link_send` + `triggerTurn: true` to each | Parallel execution, collect results via files  |

### Decision Flowchart

```
Do I need the response to continue my work?
  ├─ YES → link_prompt
  └─ NO
       ├─ Should the receiver act on it?
       │    ├─ YES → link_send (triggerTurn: true)
       │    └─ NO  → link_send (triggerTurn: false)
       └─ Multiple receivers?
            └─ YES → link_send to "*"
```

---

## Communication Protocols

### Structured Requests

When sending prompts via `link_prompt`, be explicit and self-contained. The remote agent doesn't share your conversation context.

**Good prompt:**

```
"Review the file src/auth/middleware.ts. Check for:
1. Proper JWT validation
2. Error handling for expired tokens
3. Rate limiting considerations
Report any issues found with file paths and line numbers."
```

**Bad prompt:**

```
"Review the auth code"
```

The remote agent needs: **what** to do, **where** to look, **what criteria** to apply, and **what format** to respond in.

### Status Reporting

Agents can use `link_send` to broadcast progress updates:

```
link_send → "*": "builder: finished implementing auth middleware, moving to tests"
```

This keeps the orchestrator and other agents informed without requiring a response.

### Error Handling

Things that can go wrong and how to handle them:

| Error                | Cause                                | Resolution                                   |
| -------------------- | ------------------------------------ | -------------------------------------------- |
| `"Terminal is busy"` | Target is already running a prompt   | Wait and retry, or delegate to another agent |
| Timeout (2 min)      | Remote agent took too long           | Break the task into smaller pieces           |
| `"not_delivered"`    | Target doesn't exist or disconnected | Check `link_list`, verify name               |
| No agents available  | All agents offline or busy           | Wait, or handle the task locally             |

**Retry pattern:**

```
1. link_list → check if target is idle
2. If busy → wait or pick another agent
3. If idle → link_prompt with the task
4. If timeout → break task into smaller parts, retry
```

---

## Constraints & Rules

1. **One remote prompt at a time per target.** A terminal can only process one `link_prompt` at a time. Concurrent requests are immediately rejected.

2. **2-minute timeout on `link_prompt`.** If the remote agent doesn't finish in 2 minutes, the call times out. Design prompts for focused, bounded tasks.

3. **No shared context.** Each agent has its own conversation history. When using `link_prompt`, include all necessary context in the prompt itself.

4. **Agents work in their own domain.** Agents named `role@project` typically operate on files within their project's working directory. Don't assume agents can access each other's file systems (unless they're on the same machine and paths are absolute).

5. **Broadcast excludes sender.** `link_send` to `"*"` delivers to all _other_ terminals, not back to the sender.

6. **No message persistence.** Messages are ephemeral WebSocket frames. If an agent is offline when you send, the message is lost.

7. **Hub-spoke topology.** All messages route through the hub. If the hub goes down, there's a brief disruption during hub promotion.

---

## Anti-Patterns

### ❌ Sending `link_prompt` without checking availability

```
# Bad: might get "Terminal is busy"
link_prompt → builder: "Do this task"
```

```
# Good: check first
link_list → builder is idle
link_prompt → builder: "Do this task"
```

### ❌ Using `link_send` when you need the response

```
# Bad: you'll never see the result
link_send → planner: "What's the best architecture?" (triggerTurn: true)
# ...planner responds into the void, you have no result
```

```
# Good: use link_prompt to get the answer
link_prompt → planner: "What's the best architecture?"
# → receives the answer directly
```

### ❌ Vague prompts to remote agents

```
# Bad: remote agent lacks context
link_prompt → builder: "Fix the bug"
```

```
# Good: self-contained with all context
link_prompt → builder: "There's a null pointer error in src/api/users.ts:42.
The `user` object can be undefined when the database query returns no results.
Add a null check before accessing user.email."
```

### ❌ Overloading a single agent

```
# Bad: sequential bottleneck
link_prompt → builder: task 1
link_prompt → builder: task 2
link_prompt → builder: task 3
link_prompt → builder: task 4
```

```
# Better: distribute if multiple workers are available
link_prompt → builder: task 1 + task 2
link_prompt → reviewer: task 3 (if capable)
# or use link_send with triggerTurn for parallel execution
```

### ❌ Circular delegation

```
# Bad: infinite loop
orchestrator → planner: "Ask builder what to do"
planner → builder: "Ask orchestrator what to do"
builder → orchestrator: "Ask planner what to do"
```

```
# Good: clear hierarchy, orchestrator decides
orchestrator → planner: "Design the solution"
orchestrator → builder: "Implement the plan: [details from planner]"
```

---

## Examples

### Orchestrator delegates a plan

```
# Step 1: Discovery
orchestrator calls link_list
→ planner@adaptive-bop: idle (2m)
→ builder@adaptive-bop: idle (30s)
→ reviewer@adaptive-bop: idle (1m)

# Step 2: Get a plan
orchestrator calls link_prompt:
  to: "planner@adaptive-bop"
  prompt: "We need to add WebSocket support to the API server.
           Design the implementation plan including:
           - Which files to create/modify
           - The message protocol
           - Error handling strategy
           - Testing approach
           Respond with a structured plan."

→ Planner responds with detailed plan

# Step 3: Delegate implementation
orchestrator calls link_prompt:
  to: "builder@adaptive-bop"
  prompt: "Implement WebSocket support following this plan:
           [paste planner's full plan here]
           Start with the server setup, then message handlers."

→ Builder implements and responds with summary

# Step 4: Request review
orchestrator calls link_prompt:
  to: "reviewer@adaptive-bop"
  prompt: "Review the WebSocket implementation just added.
           Key files: src/ws/server.ts, src/ws/handlers.ts
           Check for: connection lifecycle, error handling,
           memory leaks, message validation.
           List any issues found."

→ Reviewer responds with findings

# Step 5: Report to user
orchestrator synthesizes and presents the final status
```

### Builder asks reviewer for feedback

```
# A builder can also initiate communication
builder calls link_prompt:
  to: "reviewer@adaptive-bop"
  prompt: "I just refactored the database connection pool in src/db/pool.ts.
           Can you review it? I'm specifically concerned about:
           - Connection leak prevention
           - Graceful shutdown behavior
           - The retry logic in reconnect()"

→ Reviewer responds with detailed feedback
→ Builder applies fixes based on feedback
```

### Broadcast a status update

```
# Inform all agents about a change
orchestrator calls link_send:
  to: "*"
  message: "Phase 1 complete. All API endpoints are implemented.
            Moving to Phase 2: frontend integration.
            Builder: start on the React components.
            Reviewer: review the API tests before we proceed."
  triggerTurn: false

# Or steer agents to act on it
orchestrator calls link_send:
  to: "*"
  message: "Critical: the database migration in src/db/migrations/003.sql
            has a bug. Everyone stop and check if your work depends on
            the users.preferences column."
  triggerTurn: true
```

---

## Summary

| Principle                             | Detail                                                               |
| ------------------------------------- | -------------------------------------------------------------------- |
| **Discover before delegating**        | Always `link_list` first                                             |
| **Use `link_prompt` for answers**     | Only way to get a response back                                      |
| **Use `link_send` for notifications** | Fire-and-forget, with optional autonomous action                     |
| **Self-contained prompts**            | Remote agents don't share your context                               |
| **Respect busy agents**               | Check status, handle rejections, distribute load                     |
| **Clear hierarchy**                   | Orchestrator coordinates, workers execute, avoid circular delegation |
| **Bounded tasks**                     | Keep prompts focused — 2-minute timeout is real                      |
