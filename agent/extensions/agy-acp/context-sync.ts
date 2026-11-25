/**
 * Dual-context synchronization between Pi's stateless TranscriptContext and agy's stateful ACP session.
 *
 * Pi is the source of truth for conversation branches (/tree, /fork, /compact, model switches).
 * We store a watermark (sessionId, piSessionId, syncedCount, prefixHash) on each branch,
 * plus a write-ahead `pending` marker before mutating an existing ACP session:
 *  - Consecutive agy turns: branch watermark valid & prefix matches -> send only the latest user message.
 *  - Handoff from another model -> agy: branch watermark valid & prefix matches -> send delta + latest message.
 *  - Branch rollback (/tree), /fork, interrupted turn, compaction, or cwd change -> start a fresh agy session.
 */
import { createHash } from "node:crypto";
import type { AssistantMessage, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export type AcpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string };

export interface AgySyncState {
	sessionId: string;
	cwd: string;
	syncedCount: number;
	prefixHash: string;
	piSessionId: string;
}

export interface AgyPendingMarker {
	sessionId: string;
	pending: true;
}

export type AgySyncEntryData = AgySyncState | AgyPendingMarker;

export interface SessionEntryLike {
	id: string;
	type: string;
	customType?: string;
	data?: unknown;
}

export interface AgyToolRecord {
	id: string;
	title: string;
	name?: string;
	kind?: string;
	status?: string;
	target?: string;
	exitCode?: number;
	outputPreview?: string;
	durationMs?: number;
}

export interface AgyActionsEntryData {
	assistantTimestamp: number;
	tools: AgyToolRecord[];
	totalCount?: number;
	durationMs?: number;
}

export interface PromptPlan {
	mode: "continue" | "fresh";
	prompt: AcpContentBlock[];
}

const MAX_TOOL_RESULT_CHARS = 800;
const MAX_HISTORY_CHARS = 80_000;
const MAX_TOOL_SUMMARY_ITEMS = 20;

const SUMMARY_PREFIXES = [
	"The conversation history before this point was compacted into the following summary:",
	"The following is a summary of a branch that this conversation came back from:",
];

export function nonSystemMessages(messages: Message[]): Message[] {
	return messages.filter((m) => m.role !== "system");
}

function normalizeMessageForHash(msg: Message): string {
	if (msg.role === "user") {
		const blocks: (TextContent | ImageContent)[] =
			typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
		const parts = blocks.map((b) =>
			b.type === "text" ? `t:${b.text.trim()}` : `i:${b.mimeType}:${b.data.length}:${b.data.slice(0, 32)}`,
		);
		return `u:[${parts.join("|")}]`;
	}
	if (msg.role === "assistant") {
		// Hash only stable text & toolCall names (thinking blocks may be stripped across providers/reloads).
		const parts: string[] = [];
		for (const b of msg.content) {
			if (b.type === "text" && b.text.trim()) parts.push(`t:${b.text.trim()}`);
			else if (b.type === "toolCall") parts.push(`c:${b.name}:${b.id}`);
		}
		return `a:[${parts.join("|")}]`;
	}
	if (msg.role === "toolResult") {
		const text = extractText(msg.content);
		return `r:${msg.toolName}:${msg.toolCallId}:${msg.isError ? "1" : "0"}:${text.length}:${text.slice(0, 64)}`;
	}
	return "s:";
}

export function hashMessages(messages: Message[]): string {
	const h = createHash("sha256");
	for (const m of messages) {
		h.update(normalizeMessageForHash(m));
		h.update("\n\x1e\n");
	}
	return h.digest("hex").slice(0, 24);
}

function extractText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

function formatMessageForHandoff(msg: Message): string {
	if (msg.role === "user") {
		const text = extractText(msg.content).trim();
		const images = Array.isArray(msg.content) ? msg.content.filter((b) => b.type === "image").length : 0;
		const imgNote = images > 0 ? ` [${images} image${images > 1 ? "s" : ""} attached]` : "";
		return `User: ${text}${imgNote}`.trim();
	}
	if (msg.role === "assistant") {
		const lines: string[] = [];
		const modelTag = msg.model ? ` (${msg.provider}/${msg.model})` : "";
		const text = msg.content
			.filter((b): b is TextContent => b.type === "text" && b.text.trim().length > 0)
			.map((b) => b.text.trim())
			.join("\n\n");
		const toolCalls = msg.content.filter((b) => b.type === "toolCall");
		if (text) lines.push(`Assistant${modelTag}: ${text}`);
		if (toolCalls.length > 0) {
			const summary = toolCalls
				.map((tc: any) => {
					const argHint = tc.arguments?.path ?? tc.arguments?.command ?? tc.arguments?.file_path ?? "";
					return argHint ? `${tc.name}(${String(argHint).slice(0, 80)})` : tc.name;
				})
				.join(", ");
			lines.push(`Assistant${modelTag} called Pi tools: ${summary}`);
		}
		return lines.join("\n");
	}
	if (msg.role === "toolResult") {
		const raw = extractText(msg.content).trim();
		const clipped =
			raw.length > MAX_TOOL_RESULT_CHARS
				? `${raw.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated, ${raw.length} chars]`
				: raw;
		const status = msg.isError ? "ERROR" : "ok";
		return `Pi tool result (${msg.toolName}, ${status}): ${clipped || "(empty)"}`;
	}
	return "";
}

function isPinnedSummary(msg: Message): boolean {
	if (msg.role !== "user") return false;
	const text = extractText(msg.content).trimStart();
	return SUMMARY_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function formatContextBlock(messages: Message[], kind: "history" | "delta"): string {
	const entries = messages
		.map((m) => ({ text: formatMessageForHandoff(m), pinned: isPinnedSummary(m) }))
		.filter((e) => e.text.length > 0);
	if (entries.length === 0) return "";

	// Preserve a leading compaction/branch summary so trimming old turns never discards it.
	const pinnedHead = entries[0]!.pinned ? entries.shift()! : null;
	const budget = Math.max(MAX_HISTORY_CHARS - (pinnedHead ? pinnedHead.text.length + 2 : 0), 4_000);

	// Keep the most recent context within budget if a Pi session is very long.
	const kept: string[] = [];
	let total = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const chunk = entries[i]!.text;
		if (total + chunk.length > budget && kept.length > 0) {
			kept.unshift(`[… ${i + 1} earlier messages omitted for brevity]`);
			break;
		}
		kept.unshift(chunk);
		total += chunk.length + 2;
	}
	if (pinnedHead) kept.unshift(pinnedHead.text);

	const header =
		kind === "history"
			? "Context from earlier in this Pi conversation (may include turns from other models/tools before switching to you):"
			: "Conversation turns that happened in Pi since your last reply (from the user or other models):";
	return `<pi_conversation_${kind}>\n${header}\n\n${kept.join("\n\n")}\n</pi_conversation_${kind}>`;
}

function userMessageToBlocks(msg: Message): AcpContentBlock[] {
	if (msg.role !== "user") {
		const formatted = formatMessageForHandoff(msg);
		return formatted ? [{ type: "text", text: formatted }] : [];
	}
	if (typeof msg.content === "string") {
		return msg.content ? [{ type: "text", text: msg.content }] : [];
	}
	const blocks: AcpContentBlock[] = [];
	for (const part of msg.content) {
		if (part.type === "text" && part.text) {
			blocks.push({ type: "text", text: part.text });
		} else if (part.type === "image") {
			blocks.push({ type: "image", mimeType: part.mimeType, data: part.data });
		}
	}
	return blocks;
}

export function buildPromptPlan(messages: Message[], state: AgySyncState | undefined, cwd: string): PromptPlan {
	const nonSys = nonSystemMessages(messages);
	if (nonSys.length === 0) {
		throw new Error("No messages to send to agy");
	}

	// Strict `>` ensures at least one new message exists past the watermark; `<=` means a rollback or retry.
	const canContinue =
		!!state &&
		state.cwd === cwd &&
		state.syncedCount > 0 &&
		nonSys.length > state.syncedCount &&
		hashMessages(nonSys.slice(0, state.syncedCount)) === state.prefixHash;

	const mode: "continue" | "fresh" = canContinue ? "continue" : "fresh";
	const unsynced = canContinue ? nonSys.slice(state!.syncedCount) : nonSys;

	const last = unsynced[unsynced.length - 1]!;
	const prior = unsynced.slice(0, -1);
	const blocks: AcpContentBlock[] = [];

	if (prior.length > 0) {
		const contextText = formatContextBlock(prior, mode === "continue" ? "delta" : "history");
		if (contextText) blocks.push({ type: "text", text: contextText });
	}

	blocks.push(...userMessageToBlocks(last));
	if (blocks.length === 0) {
		blocks.push({ type: "text", text: "(empty message)" });
	}

	return { mode, prompt: blocks };
}

/**
 * Resolve the active branch's watermark, invalidating it if the underlying mutable ACP session
 * was left mid-turn (`pending`), was also used outside the current branch (e.g. `/tree` rollback),
 * or does not belong to the active Pi session (e.g. `/fork`).
 */
export function resolveBranchSyncState(
	branchEntries: readonly SessionEntryLike[],
	allEntries: readonly SessionEntryLike[],
	syncEntryType: string,
	piSessionId: string,
): AgySyncState | undefined {
	const branchIds = new Set<string>();
	let lastEntry: AgySyncEntryData | undefined;

	for (const entry of branchEntries) {
		branchIds.add(entry.id);
		const data = entry.data as AgySyncEntryData | undefined;
		if (entry.type === "custom" && entry.customType === syncEntryType && data?.sessionId) {
			lastEntry = data;
		}
	}
	if (!lastEntry || "pending" in lastEntry) return undefined;
	if (!piSessionId || lastEntry.piSessionId !== piSessionId) return undefined;

	for (const entry of allEntries) {
		const data = entry.data as AgySyncEntryData | undefined;
		if (entry.type !== "custom" || entry.customType !== syncEntryType || data?.sessionId !== lastEntry.sessionId) {
			continue;
		}
		if (!branchIds.has(entry.id)) return undefined;
	}
	return lastEntry;
}

// Include assistantMessage because Pi appends it to context.messages before the next turn.
export function buildNextSyncState(
	messages: Message[],
	assistantMessage: AssistantMessage,
	sessionId: string,
	cwd: string,
	piSessionId: string,
): AgySyncState {
	const synced = [...nonSystemMessages(messages), assistantMessage];
	return {
		sessionId,
		cwd,
		syncedCount: synced.length,
		prefixHash: hashMessages(synced),
		piSessionId,
	};
}

export function formatToolSummaryForTranscript(tools: AgyToolRecord[], totalCount?: number): string {
	if (tools.length === 0) return "";
	const total = Math.max(totalCount ?? tools.length, tools.length);
	const shown = tools.slice(0, MAX_TOOL_SUMMARY_ITEMS);
	const lines = shown.map((t) => {
		const failed = t.status === "failed" || (t.exitCode !== undefined && t.exitCode !== 0);
		const completed = !failed && t.status === "completed";
		const icon = failed ? "✗" : completed ? "✓" : "…";
		const kind = t.kind ? `${t.kind}: ` : "";
		const exitNote = t.exitCode !== undefined && t.exitCode !== 0 ? ` (exit ${t.exitCode})` : "";
		return `- ${icon} ${kind}${t.target || t.title}${exitNote}`;
	});
	if (total > shown.length) {
		lines.push(`- … (${total - shown.length} more internal actions)`);
	}
	return `\n\n---\n_Actions executed internally by agy (via agy's own tools, not Pi's tools):_\n${lines.join("\n")}`;
}

export function collectBranchAgyActions(
	branchEntries: readonly SessionEntryLike[],
	actionsEntryType: string,
): Map<number, AgyActionsEntryData> {
	const map = new Map<number, AgyActionsEntryData>();
	for (const entry of branchEntries) {
		if (entry.type !== "custom" || entry.customType !== actionsEntryType) continue;
		const data = entry.data as AgyActionsEntryData | undefined;
		if (typeof data?.assistantTimestamp === "number" && Array.isArray(data.tools) && data.tools.length > 0) {
			map.set(data.assistantTimestamp, data);
		}
	}
	return map;
}

function isAgyAssistant(msg: Message | { role: string }, providerName: string): msg is AssistantMessage {
	return msg.role === "assistant" && "provider" in msg && msg.provider === providerName;
}

/**
 * Non-destructively append compact agy tool summaries to matching agy assistant messages
 * for handoff to non-agy models (via `pi.on("context")`), returning undefined when unchanged.
 */
export function injectAgyActionsForHandoff<T extends Message | { role: string }>(
	messages: readonly T[],
	actionsByTimestamp: ReadonlyMap<number, AgyActionsEntryData>,
	providerName: string,
): T[] | undefined {
	if (actionsByTimestamp.size === 0) return undefined;
	let changed = false;
	const next = messages.map((m) => {
		if (!isAgyAssistant(m, providerName)) return m;
		const entry = actionsByTimestamp.get(m.timestamp);
		if (!entry) return m;
		const summary = formatToolSummaryForTranscript(entry.tools, entry.totalCount);
		if (!summary) return m;
		changed = true;
		return { ...m, content: [...m.content, { type: "text" as const, text: summary }] } as T;
	});
	return changed ? next : undefined;
}
