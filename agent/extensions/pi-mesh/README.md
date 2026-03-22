# pi-mesh

A WebSocket-based inter-terminal communication system that creates a local network between multiple Pi coding agent terminals. Enables terminals to discover each other, exchange messages, and orchestrate work across agents — all automatically on `localhost`.

> **~400 lines of TypeScript** in a single `index.ts` file. No configuration required.

---

## Table of Contents

- [Why?](#why)
- [Quick Start](#quick-start)
- [Walkthrough](#walkthrough)
- [Architecture](#architecture)
- [Protocol](#protocol)
- [LLM Tools](#llm-tools)
- [Slash Commands](#slash-commands)
- [Implementation Details](#implementation-details)
- [Dependencies](#dependencies)
- [Troubleshooting](#troubleshooting)
- [Limitations & Design Decisions](#limitations--design-decisions)

---

## Why?

A single Pi terminal is powerful. Multiple terminals working together unlock new patterns:

- **Research + Build** — one terminal investigates APIs, docs, or logs while another writes code based on the findings.
- **Fan-out** — split a large task across agents (e.g., "terminal A handles the backend, terminal B handles the frontend") and collect results.
- **Orchestrator / Worker** — designate one terminal as a coordinator that delegates subtasks to others via `mesh_prompt` and assembles the final output.
- **Review pipeline** — one terminal writes code, another reviews it, back and forth until both are satisfied.

---

## Quick Start

### Installation

```bash
cd ~/.pi/agent/extensions/pi-mesh && npm install
```

### Usage

Start two or more `pi` terminals — they discover each other automatically:

```
# Terminal 1                          # Terminal 2
$ pi                                  $ pi
  ✓ Mesh hub on :9900 as "t-a1b2"      ✓ Joined mesh as "t-c3d4" (2 online)
```

Use `/mesh` in any terminal to check status, or let the LLM tools handle cross-terminal coordination.

---

## Walkthrough

Here's a concrete example of two terminals collaborating. Open two separate `pi` sessions.

**Terminal 1** — rename and check status:

```
> /mesh-name builder
✓ Renamed to "builder"

> /mesh
⚡ Mesh: "builder" (hub) · 2 terminals online: builder, researcher
```

**Terminal 2** — rename it too:

```
> /mesh-name researcher
✓ Reconnecting as "researcher"...
```

**Now ask Terminal 1's LLM to delegate work:**

In Terminal 1, type a normal prompt:

```
> Use mesh_prompt to ask "researcher" to summarize the contents of README.md in this directory
```

The LLM in Terminal 1 calls `mesh_prompt` → Terminal 2's LLM receives the prompt, reads the file, and sends back a summary → Terminal 1's LLM presents the result to you.

**Or broadcast a message to all terminals:**

```
> /mesh-broadcast starting the deployment pipeline
✓ Broadcast sent
```

Every other terminal sees:

```
⚡ [builder] starting the deployment pipeline
```

---

## Architecture

### Hub-Spoke Topology

Despite the name "mesh," the actual topology is **hub-spoke (star)**:

```
              ┌─────────┐
              │   Hub   │
              │  (WSS   │
              │ :9900)  │
              └────┬────┘
              ╱    │    ╲
             ╱     │     ╲
      ┌──────┐ ┌──────┐ ┌──────┐
      │ pi-2 │ │ pi-3 │ │ pi-4 │
      └──────┘ └──────┘ └──────┘
       client   client   client
```

- The **first terminal** to start becomes the **hub** — it runs a `WebSocketServer` on `127.0.0.1:9900`.
- **Subsequent terminals** connect as **clients** via plain WebSocket.
- All messages route **through the hub**; clients never talk directly to each other.

### Auto-Discovery Protocol

Startup follows a graceful fallback sequence:

1. Try to read `$TMPDIR/pi-mesh.json` for existing hub connection info.
2. Attempt to connect as a **client** to the advertised port.
3. If connection fails → become the **hub** and write the mesh file.
4. If both fail (rare race condition) → retry after a randomized 2–5 second backoff.

#### Mesh File Format

The hub writes `pi-mesh.json` to the OS temp directory (`os.tmpdir()`):

```json
{
  "port": 9900,
  "pid": 12345
}
```

This is how new terminals discover the hub. The file is deleted when the hub shuts down cleanly.

### Hub Promotion

When the hub disconnects, clients detect the WebSocket close event, enter `"disconnected"` state, and call `scheduleReconnect()`. The **first terminal to retry** becomes the new hub via the same initialize-or-fallback flow.

There is **no explicit leader election** — promotion is race-based.

---

## Protocol

The wire protocol consists of **7 message types**, all serialized as JSON over WebSocket frames:

| Type              | Direction     | Purpose                                               |
| ----------------- | ------------- | ----------------------------------------------------- |
| `register`        | Client → Hub  | First message after connecting; requests a name       |
| `welcome`         | Hub → Client  | Confirms assigned name (deduplicated) + terminal list |
| `terminal_joined` | Hub → All     | Broadcast when a terminal joins                       |
| `terminal_left`   | Hub → All     | Broadcast when a terminal disconnects                 |
| `chat`            | Any → Any/All | Fire-and-forget message; optionally triggers LLM turn |
| `prompt_request`  | Any → Any     | Request a remote terminal to execute a prompt         |
| `prompt_response` | Any → Any     | Response carrying the remote prompt result            |
| `error`           | Hub → Client  | Error notification                                    |

### Message Flow Examples

**Joining the mesh:**

```
Client                          Hub
  |-- register {name:"builder"} -->|
  |<-- welcome {name:"builder",   |
  |     terminals:["pi-1"]}  ------|
  |                                 |--> terminal_joined broadcast
```

**Sending a chat message:**

```
Client A                        Hub                         Client B
  |-- chat {to:"pi-2", msg} ---->|-- chat {from:"pi-1"} ---->|
```

**Remote prompt (synchronous RPC):**

```
Client A                        Hub                         Client B
  |-- prompt_request ------------>|-- prompt_request --------->|
  |                                |                           | (LLM runs)
  |<-- prompt_response -----------|<-- prompt_response --------|
```

---

## LLM Tools

The extension registers three tools that the LLM can invoke during agent runs:

### `mesh_send`

Send a fire-and-forget chat message to a specific terminal or broadcast to all.

| Parameter     | Type      | Description                                          |
| ------------- | --------- | ---------------------------------------------------- |
| `to`          | `string`  | Target terminal name, or `"*"` for broadcast         |
| `message`     | `string`  | Message content                                      |
| `triggerTurn` | `boolean` | If `true`, the receiver's LLM responds automatically |

When `triggerTurn` is enabled, the message is delivered via `pi.sendMessage` with `deliverAs: "steer"`, causing the remote agent to kick off an LLM turn.

> **Broadcast note:** Sending to `"*"` delivers to **all other terminals** — the sender is excluded.

> **No delivery confirmation** — the sender doesn't know if the message arrived.

### `mesh_prompt`

Send a prompt to a remote terminal and **wait** for the LLM's response (synchronous RPC pattern).

| Parameter | Type     | Description          |
| --------- | -------- | -------------------- |
| `to`      | `string` | Target terminal name |
| `prompt`  | `string` | Prompt text to send  |

- The remote terminal processes the prompt via `pi.sendUserMessage()` — as if a user typed it.
- Returns the **last assistant message** text from the remote agent run.
- **2-minute timeout**; supports abort signals.
- Only **one remote prompt** can execute at a time per terminal. Concurrent requests are rejected with `"Terminal is busy"`.

### `mesh_list`

Lists all connected terminals with role info and self-identification. Takes no parameters.

**Example output:**

```
Connected terminals:
  • pi-1 (you)
  • pi-2
  • pi-3
```

---

## Slash Commands

| Command                 | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `/mesh`                 | Show mesh status (name, role, online count)     |
| `/mesh-name <name>`     | Rename this terminal on the mesh                |
| `/mesh-broadcast <msg>` | Broadcast a chat message to all other terminals |

### Examples

```
> /mesh
⚡ Mesh: "builder" (hub) · 3 online: builder, worker-1, worker-2

> /mesh-name orchestrator
✓ Renamed to "orchestrator"

> /mesh-broadcast starting the build pipeline
✓ Broadcast sent
```

---

## Implementation Details

### Name Uniqueness

The hub enforces unique terminal names via a `uniqueName()` function. If `"builder"` is already taken, the next terminal requesting that name is assigned `"builder-2"`, then `"builder-3"`, and so on.

Default names are random 4-character hex IDs: `t-a1b2`, `t-c3d4`, etc.

### State Management

| State Field              | Type                                  | Purpose                                             |
| ------------------------ | ------------------------------------- | --------------------------------------------------- |
| `role`                   | `"hub" \| "client" \| "disconnected"` | Current network role                                |
| `isAgentBusy`            | `boolean`                             | Prevents accepting remote prompts during agent runs |
| `pendingRemotePrompt`    | `object \| null`                      | Tracks the single in-flight remote prompt execution |
| `pendingPromptResponses` | `Map`                                 | Outstanding prompt RPCs awaiting responses          |

### Agent Lifecycle Integration

The extension hooks into Pi's agent lifecycle events:

- **`agent_start`** → Sets `isAgentBusy = true`, blocking incoming remote prompts.
- **`agent_end`** → Checks if a remote prompt was running. If so, extracts the last assistant response from `event.messages` and sends back a `prompt_response`.
- **`session_shutdown`** → Full cleanup: closes all sockets, resolves pending promises, and deletes `pi-mesh.json` (if hub).

### Custom Message Renderer

Incoming mesh chat messages render with a styled prefix using the theme's accent color:

```
⚡ [pi-2] Here's the analysis you requested...
```

---

## Dependencies

| Package                         | Version | Purpose                                          |
| ------------------------------- | ------- | ------------------------------------------------ |
| `ws`                            | ^8.18.0 | WebSocket library (server + client)              |
| `@types/ws`                     | ^8.5.0  | TypeScript type definitions (dev)                |
| `@mariozechner/pi-coding-agent` | —       | Pi SDK types (ExtensionAPI, ExtensionContext)    |
| `@mariozechner/pi-tui`          | —       | TUI Text widget for custom message rendering     |
| `@sinclair/typebox`             | —       | JSON Schema type definitions for tool parameters |

### `package.json`

```json
{
  "name": "pi-mesh",
  "private": true,
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0"
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

---

## Troubleshooting

### Port 9900 is already in use

If another process occupies port 9900, the terminal can't become the hub. It will attempt to connect as a client instead (which also fails if there's no real hub), then retry after 2–5 seconds. **The port is hardcoded** — there's no configuration to change it. You'll need to free the port or modify `DEFAULT_PORT` in `index.ts`.

### Stale `pi-mesh.json` after a crash

If the hub crashes without cleaning up, a stale mesh file remains in the temp directory. This is handled gracefully: the next terminal reads the file, fails to connect to the dead hub, and falls through to creating a new hub (overwriting the stale file). No manual intervention needed.

### "Terminal is busy" rejections

Each terminal can only execute **one remote prompt at a time**. If a `mesh_prompt` arrives while the agent is already running (either from a local user or another remote prompt), it's immediately rejected with `"Terminal is busy"`. There is no queuing. Solutions:

- Wait for the target terminal to finish its current task.
- Spread prompts across multiple worker terminals.
- Have the sender retry after a delay.

### Terminals don't see each other

- Verify both terminals are on the same machine (the mesh only works on `127.0.0.1`).
- Run `/mesh` in each terminal to check status.
- Check that `pi-mesh.json` exists in your OS temp directory (`$TMPDIR` / `os.tmpdir()`).

### Hub promotion loses state

When the hub goes down and a client promotes itself, terminal names and in-flight prompts from the old hub session are lost. All surviving clients reconnect and re-register. This is by design — see [Limitations](#limitations--design-decisions).

---

## Limitations & Design Decisions

| #   | Decision                              | Rationale / Impact                                                                                                                                           |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **No authentication**                 | Any localhost process can connect to port 9900. Acceptable for local dev; don't expose the port externally.                                                  |
| 2   | **Hardcoded port (9900)**             | Not configurable without editing `DEFAULT_PORT` in `index.ts`. Could conflict with other services on the same port.                                          |
| 3   | **Race-based hub promotion**          | Non-deterministic. Terminal state (names, in-flight prompts) is lost during promotion. Simple but imperfect.                                                 |
| 4   | **Single remote prompt per terminal** | No queuing — immediate rejection if the target is busy. Keeps the model simple and avoids unbounded backlogs.                                                |
| 5   | **No message persistence**            | Purely ephemeral WebSocket frames. Messages are lost if the recipient is offline.                                                                            |
| 6   | **Mesh file cleanup is hub-only**     | Only the hub deletes `pi-mesh.json` on shutdown. Stale files from crashes are handled gracefully — clients fail to connect and fall through to hub creation. |
| 7   | **Rename triggers full reconnect**    | Changing a client's name requires a new `register` message, so the client disconnects and reconnects to the hub. Hub renames are handled in-place.           |
