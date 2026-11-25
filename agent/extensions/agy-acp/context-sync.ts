/**
 * Dual-context synchronization between Pi's stateless TranscriptContext and agy's stateful ACP session.
 *
 * Pi is the source of truth for conversation branches (/tree, /fork, /compact, model switches).
 * We store a watermark (syncedCount + prefixHash) on each branch:
 *  - Consecutive agy turns: prefix matches -> send only the latest user message.
 *  - Handoff from another model -> agy: prefix matches (or no session yet) -> send delta + latest message.
 *  - Branch rollback / compaction / cwd change: prefix diverges -> start a fresh agy session with current history.
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
}

export interface AgyToolRecord {
	id: string;
	title: string;
	kind?: string;
	status?: string;
}

export interface PromptPlan {
	mode: "continue" | "fresh";
	prompt: AcpContentBlock[];
}

const MAX_TOOL_RESULT_CHARS = 800;
const MAX_HISTORY_CHARS = 24_000;
const MAX_TOOL_SUMMARY_ITEMS = 20;

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

function formatContextBlock(messages: Message[], kind: "history" | "delta"): string {
	const rendered = messages.map(formatMessageForHandoff).filter(Boolean);
	if (rendered.length === 0) return "";

	// Keep the most recent context within budget if a Pi session is very long.
	const kept: string[] = [];
	let total = 0;
	for (let i = rendered.length - 1; i >= 0; i--) {
		const chunk = rendered[i]!;
		if (total + chunk.length > MAX_HISTORY_CHARS && kept.length > 0) {
			kept.unshift(`[… ${i + 1} earlier messages omitted for brevity]`);
			break;
		}
		kept.unshift(chunk);
		total += chunk.length + 2;
	}

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

// Include assistantMessage because Pi appends it to context.messages before the next turn.
export function buildNextSyncState(
	messages: Message[],
	assistantMessage: AssistantMessage,
	sessionId: string,
	cwd: string,
): AgySyncState {
	const synced = [...nonSystemMessages(messages), assistantMessage];
	return {
		sessionId,
		cwd,
		syncedCount: synced.length,
		prefixHash: hashMessages(synced),
	};
}

export function formatToolSummaryForTranscript(tools: AgyToolRecord[]): string {
	if (tools.length === 0) return "";
	const shown = tools.slice(0, MAX_TOOL_SUMMARY_ITEMS);
	const lines = shown.map((t) => {
		const icon = t.status === "failed" ? "✗" : "✓";
		const kind = t.kind ? `${t.kind}: ` : "";
		return `- ${icon} ${kind}${t.title}`;
	});
	if (tools.length > shown.length) {
		lines.push(`- … (${tools.length - shown.length} more internal actions)`);
	}
	return `\n\n---\n_Actions executed internally by agy (via agy's own tools, not Pi's tools):_\n${lines.join("\n")}`;
}
