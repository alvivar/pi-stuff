# agy-acp

Use Google Antigravity (`agy`) models—including **Gemini 4 Neon**, Carbon, Hydrogen, and 3.8 Flash—directly inside [Pi](https://github.com/badlogic/pi-mono) as a native model provider over the official Agent Client Protocol (`agy acp`).

Pick `agy/gemini-4-neon` from `/model`, toggle thinking depth with `Shift+Tab`, watch real context usage in Pi's footer, and switch freely between Antigravity, Claude, and OpenAI models inside the same Pi conversation.

---

## Quick Start

### Prerequisites

- **Pi** (`@earendil-works/pi-coding-agent`)
- **Google Antigravity CLI (`agy`)**, installed and authenticated (`agy --login` or `agy`)

### Install

Place this folder at `~/.pi/agent/extensions/agy-acp/` (auto-discovered by Pi), then run `/reload` inside Pi or start a new session:

```bash
pi --list-models agy
```

Select any `agy/*` model via `/model` (for example `agy/gemini-4-neon`).

### Configuration

- `AGY_BIN` *(optional)*: explicit path to the `agy` binary if it is not on `PATH` or in the default install location.

---

## How It Works

`agy acp` is a stateful agent protocol, whereas Pi's standard providers are stateless. `agy-acp` bridges both models so Pi stays your primary interface:

### 1. Synchronized Context & Model Switching
Pi remains the source of truth for the conversation tree. After each `agy` turn, `agy-acp` stores a lightweight watermark (`sessionId`, message count, and prefix hash) on the current Pi branch:

- **Consecutive `agy` turns:** only your new message (and attached images) is sent; `agy` keeps its own in-session memory without re-sending history.
- **Switching from another model → `agy`:** only the turns that happened since the last watermark are forwarded as a compact delta.
- **Switching from `agy` → another model:** `agy`'s replies are saved as normal Pi assistant messages, with a compact footnote of files/commands `agy` touched internally so the next model knows what changed.
- **`/resume`, `/tree`, `/fork`:** resuming a Pi session lazily reconnects to the matching `agy` session via `session/resume`. Rolling back in `/tree`, forking, or changing `cwd` automatically starts a fresh `agy` session with the active branch's history.

### 2. Combined Tools (`agy` Native + Pi Extensions)
- **Coding & terminal tools:** `agy` runs its own file, search, web, and shell tools internally, launched with `--dangerously-skip-permissions` to match Pi's permissionless workflow. Live tool progress appears in a temporary widget above Pi's editor.
- **Pi extension tools (`pi-link`, `codemode`, MCP servers, etc.):** any active non-core Pi tool (everything except `read`, `write`, `edit`, `bash`) is automatically exposed to `agy` through an ephemeral, loopback-only Streamable HTTP MCP server (`127.0.0.1` with a per-process random bearer token). When `agy` invokes one, `agy-acp` pauses the MCP call, emits a native Pi `toolCall`, lets Pi execute it with your real session identity, hooks, and UI, and feeds the `toolResult` back into the same `agy` turn.

### 3. Compaction
- `agy`'s live window occupancy (`usage_update.used`) is reported to Pi's context meter, so auto-compaction in `agy` lowers Pi's meter automatically instead of triggering duplicate compaction.
- Pi's `/compact` and `/tree` branch summaries run as isolated one-off summary calls (Pi extension tools are omitted, the prompt instructs `agy` not to invoke its native tools on a best-effort basis, the temporary ACP session is closed immediately, and sync state is untouched). On the next chat turn, `agy` starts a fresh session seeded with Pi's pinned summary.

---

## Current Trade-offs

- **Internal `agy` tools bypass Pi's `tool_call` hooks:** file edits and shell commands run by `agy` are not intercepted by Pi extensions (bridged Pi extension tools *do* run through Pi's full tool lifecycle).
- **Pi's system prompt and `<available_skills>` are not injected yet:** `agy` uses its own system prompt and skills. CLI-based Pi skills (like `pi-dock`) can still be invoked by `agy`'s shell once referenced or registered under `~/.gemini/config/skills/`.
- **Single active turn per Pi process:** concurrent `agy` streams in one Pi process are not supported.
- **Model window sizes on refresh:** `agy acp` does not report per-model context windows in its catalog, so `refreshModels` pairs live model IDs with prefix-based window defaults (`1M` Gemini, `200K` Claude, `128K` GPT-OSS).

---

## File Map

| File | Responsibility |
| --- | --- |
| [`index.ts`](./index.ts) | Pi provider registration, ACP lifecycle, streaming, widget, and MCP ↔ `toolUse` continuation loop |
| [`acp-client.ts`](./acp-client.ts) | Minimal stdio NDJSON JSON-RPC 2.0 client for `agy acp` |
| [`context-sync.ts`](./context-sync.ts) | Pure watermark hashing, cross-model handoff formatting, and compaction-summary pinning |
| [`mcp-bridge.ts`](./mcp-bridge.ts) | Ephemeral localhost Streamable HTTP MCP server bridging Pi extension tools into `agy` |
