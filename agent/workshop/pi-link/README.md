# pi-link

A WebSocket-based inter-terminal communication system that creates a local network between multiple Pi coding agent terminals. Enables terminals to discover each other, exchange messages, and orchestrate work across agents - all automatically on `localhost`.

> One agent messaging tool: `link_send`. Dispatch work to another terminal and receive conventional callbacks. Start two Pi terminals with `--link` — they find each other automatically.

---

## Table of Contents

- [Why?](#why)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Walkthrough](#walkthrough)
- [Configuration](#configuration)
- [LLM Tools](#llm-tools)
- [Slash Commands](#slash-commands)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Limitations & Design Decisions](#limitations--design-decisions)
- [Dependencies](#dependencies)
- [Internals](#internals)

---

## Why?

A single Pi terminal is powerful. Multiple terminals working together unlock new patterns:

- **Research + Build** - one terminal investigates APIs, docs, or logs while another writes code based on the findings.
- **Parallel work** - split a large task across agents (e.g., "terminal A handles the backend, terminal B handles the frontend") and collect results.
- **Orchestrator / Worker** - designate one terminal as a coordinator that delegates subtasks with `link_send`, tracks callbacks, and assembles the final output.
- **Review pipeline** - one terminal writes code, another reviews it, back and forth until both are satisfied.

---

## Prerequisites

- [Pi coding agent](https://github.com/badlogic/pi-mono), version **0.74 or later** (for pi-link 0.1.15+). On Pi ≤0.73, pin `pi-link@0.1.14`.
- Node.js (LTS recommended)

---

## Quick Start

### Install

The minimum install — enables every in-Pi feature (`/link`, `link_send`, `/link-connect`, `--link` flag, auto-resume, and all LLM tools):

```bash
pi install npm:pi-link
```

That's it. For most users this is all you need.

#### Optional: shell launcher

If you also want the `pi-link <name>` shell command to start named sessions from a terminal prompt (e.g. `pi-link builder` in one window, `pi-link reviewer` in another), install the CLI globally as well:

```bash
npm i -g pi-link
```

Or install both in one line:

```bash
pi install npm:pi-link && npm i -g pi-link
```

The shell launcher is convenience-only — you can always reach the same functionality from inside Pi via `/link-connect` and `/link-name <name>`.

### Uninstall

```bash
pi uninstall npm:pi-link      # Remove Pi extension
npm uninstall -g pi-link      # Remove CLI launcher (if you installed it)
```

### Usage

Link is **off by default**. Two ways to start:

```bash
pi --link            # try it now, random name like t-a3f9
pi-link mybot        # named session you can resume by name
```

Already in a session? Use `/link-connect`. Use `/link` any time to check status, or let the LLM tools handle cross-terminal coordination. See [Session Resume](#session-resume) for `pi-link <name>` details.

### Notes on installation

**Why two installs?** Pi 0.75 installs Pi packages into a private npm root (`~/.pi/agent/npm/`) for safer permission handling ([pi-mono#4587](https://github.com/earendil-works/pi-mono/issues/4587)). That's where the Pi extension lives, but it means the `pi-link` shell command is no longer on system PATH. `npm i -g pi-link` puts it on PATH separately. Both installs are safe to use together.

---

## Walkthrough

Here's a concrete example of two terminals collaborating. Open two separate `pi --link` sessions.

**Terminal 1** - rename and check status:

```
> /link-name builder
✓ Renamed to "builder"

> /link
⚡ Link: builder (hub) · 2 online
  builder: idle (5s) · 45K/272K (17%)
    cwd: ~/my-project
  researcher: idle (12s) · 80K/272K (29%)
    cwd: ~/my-project
```

**Terminal 2** - rename it too:

```
> /link-name researcher
✓ Reconnecting, requesting "researcher" (hub may assign a different name if taken)...
```

**Now ask Terminal 1's LLM to delegate work:**

In Terminal 1, type a normal prompt:

```
> Use link_send to ask "researcher" to summarize README.md, then report DONE with the summary back to builder
```

Terminal 1 calls `link_send` and returns immediately. The message enters Terminal 2's reasoning — steered into its current run if it is working, or starting a turn if it is idle. Terminal 2 completes the assignment, then sends a conventional `DONE` callback. That callback enters Terminal 1 the same way, where the result can be presented or used for follow-up work.

---

## Configuration

Link is **off by default**. Without `--link`, `--link-name`, or `pi-link`, the extension is completely silent — no status bar, no connections, no warnings.

**Naming concepts**

- **link name** — identity used on the network (visible in `link_list`, `/link`, and messages).
- **Pi session name** — identity Pi gives the session itself; lives in the session JSONL's latest `session_info` entry.
- **saved link name** — the link name persisted to the session, restored on resume. Set by `/link-name`, `pi-link <name>`, or `pi --link-name <name>`.
- **`--link-name` flag vs `/link-name` command** — same concept (the link name) at different times (startup vs mid-session).

| What you want                        | Use                     |
| ------------------------------------ | ----------------------- |
| Resume/create a named session        | `pi-link <name>`        |
| Stable link identity, normal Pi flow | `pi --link-name <name>` |
| Quick try, random name               | `pi --link`             |
| Already in a session                 | `/link-connect`         |
| Disconnect mid-session               | `/link-disconnect`      |

`pi-link <name>` resumes/creates a session AND sets your link identity in one step. `pi --link-name <name>` sets only the link identity, leaving Pi's normal session selection (latest in cwd, or fresh) untouched.

**Name normalization:** Link names are normalized — leading/trailing whitespace removed and internal whitespace runs collapsed to a single space. `/link-name "build   lead"` saves and shows as `build lead`.

**Name precedence:** `pi --link-name` > `pi-link <name>` > saved `/link-name` > Pi session name > random `t-xxxx`. _(The `pi-link` wrapper itself does not accept `--link-name`; pick one or the other.)_

`/link-connect` and `/link-disconnect` save their intent to the session — resume later and the connection state is restored without needing the flag. Explicit user intent takes precedence over `--link`.

Once connected, terminals discover each other on `127.0.0.1:9900`. See [Limitations](#limitations--design-decisions) for the hardcoded port.

### Session Resume

Pi's `--session` flag requires a file path, not a display name. `pi-link` bridges this — it resolves a session by name and launches Pi directly:

```bash
pi-link worker-1                # resume or create session "worker-1"
pi-link worker-1 --model sonnet # with extra Pi flags
```

How it works: `pi-link worker-1` scans Pi's session directory, finds the session named "worker-1", and spawns `pi --session <path> --link`. Session-dir resolution matches Pi's lookup order: `PI_CODING_AGENT_SESSION_DIR` env > `<cwd>/.pi/settings.json` `sessionDir` > `<agentDir>/settings.json` `sessionDir` > default `<agentDir>/sessions/`. `<agentDir>` follows `PI_CODING_AGENT_DIR` and defaults to `~/.pi/agent/`.

Lookup is **scoped to the current cwd by default**; pass `--global` (`-g`) to consider sessions in any cwd.

- **One match in scope** → resumes that session
- **No match in scope** → creates a new session in the current cwd. If matches exist outside the scope, prints a hint pointing at `--global`.
- **Multiple matches in scope** → prints candidates to stderr, exits 1
- **Conflicting flags** (`--session`, `--continue`, `--resume`, `--fork`, etc.) → rejected with an error

### Discovering sessions

`pi-link --list` shows pi-link sessions in the current cwd; `pi-link --list --global` (or `-g`) lists them across all directories. Sorted by last activity — starting a session with the same name it already has does not bump recency; only real activity (messages, tool calls, edits, name changes) does.

```
$ pi-link --list
NAME             MODIFIED  MESSAGES  ID
opus@pi-link     2m ago    4632      6332faab
gpt@pi-link      5m ago    1493      20d43841

Resume: pi-link <name>
```

With `--global`:

```
$ pi-link --list --global
NAME             CWD                   MODIFIED  MESSAGES  ID
opus@pi-link     ~/my-project          2m ago    4632      6332faab
gpt@pi-link      ~/other-project       5m ago    1493      20d43841

Resume: pi-link <name>
```

`--global` adds a `CWD` column with `~` substituted for `$HOME`. Output is plain when piped (`NO_COLOR` honored).

`pi-link <name>` and `pi-link --resolve <name>` follow the same scoping: local cwd by default, `--global` (or `-g`) widens. When `pi-link <name>` finds no local match but matches exist elsewhere, it warns and points at `--global` instead of silently jumping cwds.

For scripting, `pi-link --resolve <name>` prints just the session path (machine-readable, no other output). Exit codes: `0` on single match, `1` if ambiguous (multiple matches printed to stderr), `2` if not found.

---

## LLM Tools

The extension registers three tools. `link_send` is the sole agent messaging tool; `link_list` provides discovery and status, and `link_compact` is a separate bounded blocking operation. pi-link also ships a **pi-link-coordination** skill with dispatch and callback guidance.

### Which tool should I use?

| Tool           | Behavior                                           | Returns                                             |
| -------------- | -------------------------------------------------- | --------------------------------------------------- |
| `link_send`    | Send a message to one other terminal               | Send/delivery status only                           |
| `link_list`    | List currently connected terminals                 | Terminal list with roles, status, cwd, and context  |
| `link_compact` | Ask another terminal to compact its context window | Waits for completion; returns compacted or an error |

### `link_send`

Send a message to one other terminal. The sender returns immediately.

| Parameter | Type     | Description          |
| --------- | -------- | -------------------- |
| `to`      | `string` | Target terminal name |
| `message` | `string` | Message content      |

Every message is delivered to the receiver's model. Messages arriving within about 200ms are held and delivered together as one `[Link: N message(s) received]` block, in arrival order, each under a `From "name":` header.

The receiver's state is read when that batch is delivered, not when it is sent. If the receiver is still running then, the batch is steered into that run at Pi's next safe boundary — current tool calls finish first, before the next LLM call. Otherwise it starts a turn. There is no way to send without entering the receiver's reasoning.

Each send has exactly one recipient; there is no fan-out.

`link_send` never returns the receiver's eventual work result. A reply is an ordinary later `link_send`, uncorrelated with the message that prompted it: there is no request ID, no automatic response, and no delivery receipt for completed work.

Targets are pre-validated against the local terminal list to catch definite typos or offline names. Sending to yourself is rejected. For a client, a successful send means the hub accepted the message, not that it arrived — see [Message Routing](#message-routing--error-handling).

### `link_list`

Lists all connected terminals with role info, live agent status, working directory, context usage, and self-identification. Takes no parameters.

Each terminal reports its current working directory on connect. `link_list` shows the full absolute path.

Each terminal also reports its current LLM context usage, rendered as `45K/272K (17%)` — tokens used over the context window, with percent. Briefly after compaction it shows as `?/272K` until the next live token count arrives.

Each terminal's status is derived automatically from Pi lifecycle events - agents can't set it manually. Three states:

| Status            | Meaning                 |
| ----------------- | ----------------------- |
| `idle (2m)`       | Waiting for user input  |
| `thinking (3s)`   | LLM is generating       |
| `tool:bash (12s)` | Running a specific tool |

Durations are computed at render time from a `since` timestamp - no timer traffic over the wire. Terminals that just joined with no status data yet render as blank, not fake idle.

Working directories use full absolute paths in tool output. In the TUI (`/link`), paths are shortened to `~/...` when possible to keep the display compact.

**Example output:**

```
Connected terminals:
  • opus@pi-link (you)  idle (12s)  · 45K/272K (17%)
    cwd: C:\Users\andre\.pi
  • gpt@pi-link  thinking (3s)  · ?/272K
    cwd: C:\Users\andre\.pi
  • docs@pi-link  idle (1m)  · 90K/272K (33%)
    cwd: C:\Users\andre\.pi
```

### `link_compact`

Ask another terminal to compact its context window and **wait up to 180 seconds** for it — a separate bounded blocking tool, not agent messaging. The next call can then dispatch work to the freshly trimmed worker.

| Parameter      | Type     | Description                                            |
| -------------- | -------- | ------------------------------------------------------ |
| `to`           | `string` | Target terminal name                                   |
| `instructions` | `string` | Optional custom compaction instructions for the target |

- The remote terminal runs `ctx.compact()` — the same code path as `/compact`. The call returns once the runtime reports completion.
- **Success** result: `Compacted "<name>"`. The worker is now idle with a trimmed context, ready for the next dispatch.
- **Busy decline** — if the target is mid-turn or already compacting, it declines immediately with `reason: "busy"`. It does not interrupt active work.
- **Self-target rejection** — calling `link_compact` on yourself returns an error pointing at `/compact`.
- **Flat 180-second timeout** — compaction typically takes 5–60s. The timeout bounds the caller's wait only; nothing aborts the target, so a timed-out call may mean the compaction is still running.
- Supports abort signals.
- Each call targets one terminal; independent calls can run concurrently.
- Any connected terminal can request compaction on another; link participants are cooperating peers.

---

## Slash Commands

| Command                 | Purpose                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/link`                 | Show link status (name, role, online count, agent status, context usage, and cwd per terminal)                           |
| `/link-name [name]`     | Rename and save as this session's preferred link name. With no argument, adopts the Pi session name. Restored on resume. |
| `/link-connect`         | Connect to Pi Link (works anytime, with or without `--link`)                                                             |
| `/link-disconnect`      | Disconnect from Pi Link and suppress auto-reconnect (overrides `--link`)                                                 |

### Examples

```
> /link
⚡ Link: builder (hub) · 3 online
  builder: idle (12s) · 45K/272K (17%)
    cwd: ~/my-project
  worker-1: thinking (3s) · ?/272K
    cwd: ~/my-project
  worker-2: tool:bash (5s) · 180K/272K (66%)
    cwd: ~/other-project

> /link-name orchestrator
✓ Renamed to "orchestrator"

> /link-name
✓ Renamed to "my-session"

> /link-disconnect
✓ Disconnected from link

> /link-connect
✓ Joined link as "orchestrator" (3 online)
```

With no argument, `/link-name` adopts the Pi session name. `/link-connect` joins an existing hub if one is running; otherwise it starts the hub.

**Name persistence:** `/link-name` saves your preferred name to the session. Resume later and it's restored automatically. If the name is taken, the hub assigns a variant (e.g., `"builder-2"`), but your preferred name stays saved for the next reconnect. See [Name Uniqueness & Persistence](#name-uniqueness--persistence) for details.

See [Configuration](#configuration) for details on `--link`, `/link-connect`, and `/link-disconnect` behavior.

---

## Architecture

### Hub-Spoke Topology

The network topology is **hub-spoke (star)**:

```
                       +-----------+
                       |    Hub    |
                       |   :9900   |
                       +-----+-----+
                             |
              +--------------+--------------+
              |              |              |
          +---+---+      +---+---+      +---+---+
          | pi-2  |      | pi-3  |      | pi-4  |
          |client |      |client |      |client |
          +-------+      +-------+      +-------+
```

- The **first terminal** to start becomes the **hub** - it runs a `WebSocketServer` on `127.0.0.1:9900`.
- **Subsequent terminals** connect as **clients** via plain WebSocket.
- All messages route **through the hub**; clients never talk directly to each other.

### Auto-Discovery Protocol

The discovery sequence runs on startup (with `--link` or `pi-link`) or when `/link-connect` is used. See [Configuration](#configuration) for details.

The sequence is a simple fallback:

1. Attempt to connect as a **client** to `127.0.0.1:9900`.
2. If connection fails → become the **hub** (start a WebSocket server on that port).
3. If both fail (rare race condition) → retry after a randomized 2-5 second backoff.

### Hub Promotion

When the hub disconnects, clients detect the WebSocket close event, enter `"disconnected"` state, and call `scheduleReconnect()`. The **first terminal to retry** becomes the new hub via the same initialize-or-fallback flow.

There is **no explicit leader election** - promotion is race-based.

---

## Troubleshooting

### Port 9900 is already in use

If another process occupies port 9900, the terminal can't become the hub. It will attempt to connect as a client instead (which also fails if there's no real hub), then retry after 2-5 seconds. Free the port or modify `DEFAULT_PORT` in `index.ts` - see [Limitations](#limitations--design-decisions).

### `link_compact` reports a busy target

A `link_compact` request does not interrupt an active agent run or another compaction. It resolves with `Compact on "<target>" not done: busy`. `link_send` is different: it is steered into an active run rather than declined.

### Terminals don't see each other

- Verify both terminals are on the same machine (the link only works on `127.0.0.1`).
- Run `/link` in each terminal to check status.
- Ensure port 9900 isn't blocked or occupied by a non-link process.

### Hub promotion loses state

When the hub goes down and a client promotes itself, terminal names and in-flight messages from the old hub session may be lost. All surviving clients reconnect and re-register. This is by design - see [Limitations](#limitations--design-decisions).

---

## Limitations & Design Decisions

| #   | Decision                                  | Rationale / Impact                                                                                                                                    |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No authentication**                     | Any localhost process can connect to port 9900. Acceptable for local dev; don't expose the port externally.                                          |
| 2   | **Hardcoded port (9900)**                 | Not configurable without editing `DEFAULT_PORT` in `index.ts`. Could conflict with other services on the same port.                                  |
| 3   | **Race-based hub promotion**              | Non-deterministic. Terminal names and in-flight ephemeral messages can be lost during promotion. Simple but imperfect.                               |
| 4   | **No message persistence**                | Purely ephemeral WebSocket frames. Messages are lost if the recipient is offline.                                                                    |
| 5   | **Client rename triggers full reconnect** | Changing a client's name requires a new `register` message, so the client disconnects and reconnects. Hub renames are handled in-place.              |
| 6   | **Single-machine / localhost-only**       | Link only binds to `127.0.0.1`; terminals on different machines cannot join.                                                                         |
| 7   | **Callbacks are conventional**            | Async work results are uncorrelated messages, not protocol responses. Coordinators must track outstanding workers and request explicit callbacks.    |

---

## Dependencies

### Runtime (installed by `pi install`)

| Package | Version | Purpose                             |
| ------- | ------- | ----------------------------------- |
| `ws`    | ^8.20.0 | WebSocket library (server + client) |

### Development

| Package     | Version | Purpose                     |
| ----------- | ------- | --------------------------- |
| `@types/ws` | ^8.18.1 | TypeScript type definitions |

### Provided by Pi (no install needed)

| Package                           | Purpose                                          |
| --------------------------------- | ------------------------------------------------ |
| `@earendil-works/pi-coding-agent` | Pi SDK types (ExtensionAPI, ExtensionContext)    |
| `@earendil-works/pi-tui`          | TUI Text widget for custom message rendering     |
| `typebox`                         | JSON Schema type definitions for tool parameters |

> **Pi version requirement:** pi-link 0.1.15+ requires Pi 0.74 or later (the `@earendil-works/*` namespace). Users on Pi 0.73 or earlier should pin `pi-link@0.1.14`.

### `package.json`

```json
{
  "name": "pi-link",
  "bin": {
    "pi-link": "./bin/pi-link.mjs"
  },
  "dependencies": {
    "ws": "^8.20.0"
  },
  "devDependencies": {
    "@types/ws": "^8.18.1"
  },
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"]
  }
}
```

`pi.extensions` tells Pi which files to load as extensions. `pi.skills` registers bundled skill directories. `bin` exposes the `pi-link` CLI (see [Configuration](#configuration)).

---

## Internals

> This section covers implementation details for contributors and developers who want to understand or modify the extension's internals.

### Protocol

The wire protocol consists of **9 message types**, all serialized as JSON over WebSocket frames. Cwd and context fields are optional.

| Type               | Direction       | Purpose                                                                             |
| ------------------ | --------------- | ----------------------------------------------------------------------------------- |
| `register`         | Client → Hub    | First message after connecting; requests a name, optionally reports cwd and context |
| `welcome`          | Hub → Client    | Confirms assigned name, terminal list + status/cwd/context snapshots                |
| `terminal_joined`  | Hub → All       | Broadcast when a terminal joins; may include cwd and context                        |
| `terminal_left`    | Hub → All       | Broadcast when a terminal disconnects                                               |
| `chat`             | Any → Any       | Message delivered to the receiver's model: steered into a running agent, or starting a turn if idle |
| `compact_request`  | Any → Any       | Request a remote terminal to compact its context; awaits a response                 |
| `compact_response` | Any → Any       | Completion/failure response for a compact_request                                   |
| `status_update`    | Any → Hub → All | Terminal broadcasts agent status change; carries updated context                    |
| `error`            | Hub → Client    | Error notification                                                                  |

### Message Flow Examples

**Joining the link:**

```
Client                         Hub
  |                             |
  | register {name:"builder",   |
  |           cwd:"C:\\Users\\..."} |
  |---------------------------->|
  |                             |
  | welcome {name, terminals,   |
  | statuses, cwds}             |
  |<----------------------------|
  |                             |
```

Hub then broadcasts `terminal_joined` to the other connected terminals. The `welcome` message includes status, cwd, and context snapshots for all connected terminals (fields omitted above for brevity). `terminal_joined` also includes the new terminal's optional cwd and context.

**Sending a chat message:**

```
Client A            Hub              Client B
  |                  |                  |
  | chat {to:pi-2}   |                  |
  |----------------->|                  |
  |                  | chat {from:A}    |
  |                  |----------------->|
  |                  |                  |
```

### Name Uniqueness & Persistence

The hub enforces unique terminal names via a `uniqueName()` function. If `"builder"` is already taken, the next terminal requesting that name is assigned `"builder-2"`, then `"builder-3"`, and so on.

Default names are random 4-character hex IDs: `t-a1b2`, `t-c3d4`, etc.

**Persistence:** `/link-name` saves the preferred name to the session via `pi.appendEntry("link-name", { name })`. On session resume, the saved name is restored and requested from the hub. Only explicit `/link-name` calls persist - hub-assigned variants like `"builder-2"` are not saved. On reconnect, the terminal always requests the preferred name, not the last runtime name.

**Rename guards:**

- If you're already using the requested name, `/link-name` returns early (`"Already using..."`).
- On the hub, renaming checks if the name is taken by another connected client before accepting the change.
- On a client, the rename triggers a reconnect; the hub enforces uniqueness during re-registration and may assign a different name if taken.

**Unregistered client guard:** The hub ignores all non-`register` messages from clients that haven't completed registration, preventing protocol violations from malformed or out-of-order messages.

### State Management

| State Field               | Type                                  | Purpose                                                                          |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `role`                    | `"hub" \| "client" \| "disconnected"` | Current network role                                                             |
| `agentRunning`            | `boolean`                             | Whether an agent run is active; drives status and blocks incoming compact        |
| `compactRunning`          | `boolean`                             | Whether this terminal is compacting for a remote request                         |
| `localCompacting`         | `boolean`                             | Whether a `manual`-reason compaction is in progress; holds inbox delivery        |
| `activeToolName`          | `string \| null`                      | Name of the currently executing tool (drives `tool:<name>` status)               |
| `stateSince`              | `number`                              | Timestamp of last status change (used for duration display)                      |
| `currentCwd`              | `string`                              | Current working directory reported to peers on connect                           |
| `inbox`                   | `array`                               | Queued incoming messages awaiting delivery                                       |
| `flushTimer`              | `Timer \| null`                       | Pending inbox flush (burst debounce)                                             |
| `compactDeadline`         | `Timer \| undefined`                  | Backstop releasing the inbox if a compaction reports no ending                   |
| `pendingCompactResponses` | `Map`                                 | Outstanding compact requests awaiting bounded responses                          |
| `disposed`                | `boolean`                             | Set on shutdown; guards WebSocket callbacks against stale context                |
| `startupConnectTimer`     | `Timer \| null`                       | Deferred startup connect so Pi's startup cycle completes first                   |
| `manuallyDisconnected`    | `boolean`                             | Set by `/link-disconnect`; suppresses auto-reconnect                             |

### Message Routing & Error Handling

`routeMessage()` returns a `boolean` indicating delivery status:

- **Hub** - delivery is authoritative. If a chat target is not connected, the hub sends a protocol-level error back to a client sender; a local hub sender already receives the failed delivery result. A `compact_request` to an unknown target gets a synthesized `compact_response` (`ok: false`, `reason: "not_found"`), so the bounded compact call fails fast.
- **Client** - delivery is optimistic (`true` means "sent to hub"). The hub handles routing and errors via the protocol.

### Connection Lifecycle

Internally, teardown is split into two functions:

- **`disconnect()`** - closes sockets, clears connection state, resolves pending promises. Used by `/link-disconnect` and called internally by `cleanup()`.
- **`cleanup()`** - calls `disconnect()`, sets `disposed = true`, clears `ctx`. Used on `session_shutdown`.

Three helpers protect WebSocket callbacks from stale extension context:

- **`getUi()`** - safely accesses `ctx.ui`, returns `null` if the context is invalidated.
- **`notify()`** - wraps `getUi()?.notify()` for safe notification delivery.
- **`isRuntimeLive()`** - returns `false` if `disposed` or context is stale; checked before processing any incoming WebSocket message.

Startup connect is deferred via `scheduleStartupConnect()` (`setTimeout(0)`) so Pi's startup cycle completes and the extension context is fully valid before WebSocket work begins.

The `manuallyDisconnected` flag distinguishes user-initiated disconnects (`/link-disconnect`) from connection loss. When set, `scheduleReconnect()` is suppressed - the terminal stays offline until `/link-connect` is explicitly called.

### Agent Lifecycle Integration

The extension hooks into Pi's agent lifecycle events:

- **`agent_start`** → Sets `agentRunning = true`, which drives status and prevents remote compaction from interrupting active work. Clears the local compaction gate, since a resumed run means any compaction has ended. Broadcasts `status_update` (`thinking`).
- **`agent_end`** → Broadcasts `status_update` (`idle`).
- **`tool_execution_start`** → Broadcasts `status_update` (`tool:<name>`).
- **`tool_execution_end`** → Clears tool status; broadcasts `status_update` (`thinking`) while the agent run continues.
- **`session_before_compact`** → For a manual compaction, holds inbox delivery until the compaction ends. Automatic (threshold/overflow) compaction is left alone: it runs inside the agent run, where Pi already queues and drains steered messages itself.
- **`session_compact`** → Clears the local compaction gate and force-pushes a `status_update` so peers see the new (post-compaction) context usage immediately.
- **`session_shutdown`** → Full cleanup via `cleanup()`: closes all sockets, resolves pending promises, and disposes the extension.

Status updates are push-based: each terminal broadcasts changes to the hub, which fans them out. New joiners receive a status snapshot for all terminals in the `welcome` message. Context updates reuse the same status path, including a forced post-compaction update.

### Inbox

An arriving `chat` message goes into a local inbox rather than calling `pi.sendMessage()` immediately, so that burst arrivals can be coalesced into a single delivery.

The flush pipeline:

1. **Debounce** - `scheduleFlush(FLUSH_DELAY_MS)` coalesces burst arrivals (200ms window).
2. **Compaction gate** - `flushInbox()` returns without rescheduling while a gated compaction is in progress.
3. **Batch** - up to 20 messages or ~16 000 chars per delivery (soft cap - the first item is always included even if oversized).
4. **Deliver** - one `pi.sendMessage()` call with a `[Link: N message(s) received]` block. Pi reads the receiver's state at this point — not at send time — to decide whether the batch steers a running agent or starts a turn.
5. **Drain** - if the inbox still has items, reschedule.

Delivery is held while this terminal runs a `manual`-reason compaction, because a message delivered mid-compaction would be reasoned about against context that is being rebuilt. Two flags gate it: `compactRunning` for a compaction serving a remote `link_compact`, and `localCompacting`, set from `session_before_compact`. A remote request raises both, since Pi reports its own reason as `manual` either way. Automatic (threshold/overflow) compaction is deliberately **not** gated: it runs inside the agent run, where Pi already queues steered messages and drains them afterwards.

Because a gated flush does not reschedule, the release path is load-bearing. `releaseInbox()` is called after either flag clears and schedules a flush only when neither gate remains — so a remote compaction's `session_compact` calls it and correctly does nothing, and the later `finish()` is what drains. `compactDeadline` is the backstop, since a failed compaction reports no ending to an extension at all.

| Constant             | Value   | Purpose                                        |
| -------------------- | ------- | ---------------------------------------------- |
| `FLUSH_DELAY_MS`     | 200     | Burst debounce window                          |
| `BATCH_MAX_ITEMS`    | 20      | Max messages per batch                         |
| `BATCH_MAX_CHARS`    | 16 000  | Soft cap on batch text size (~4K tokens)       |
| `COMPACT_TIMEOUT_MS` | 180 000 | Remote-compact wait, reused as the gate backstop |

### Rendering

Delivered link batches render with a styled `⚡ [link]` prefix using the theme's accent color; sender attribution lives in the `From "name":` blocks inside the message body, not in the prefix. The link status text in Pi's footer uses `theme.fg("dim", ...)` to match Pi's standard footer styling.
