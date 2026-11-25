/**
 * TUI visualization for internal `agy acp` tools:
 *  - Rich extraction of ACP `tool_call` / `tool_call_update` metadata (verb, relative path/command, exit code, preview).
 *  - Live themed `@earendil-works/pi-tui` widget (`Box` + `TruncatedText` + spinner) while a turn runs.
 *  - Collapsible transcript card via `pi.registerEntryRenderer` (`Ctrl+O` to expand outputs/details).
 */
import * as path from "node:path";
import type { EntryRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, type TUI, TruncatedText } from "@earendil-works/pi-tui";
import type { AgyActionsEntryData, AgyToolRecord } from "./context-sync.ts";

export interface AgyPlanEntry {
	content: string;
	status: string;
}

export interface LiveToolTurnState {
	startedAt: number;
	tools: AgyToolRecord[];
	plan: AgyPlanEntry[];
}

export interface LiveToolWidgetComponent extends Component {
	update(): void;
	dispose(): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LIVE_ROWS = 6;
const MAX_COLLAPSED_ROWS = 4;
export const MAX_STORED_TOOLS = 50;
const MAX_PREVIEW_LINES = 6;
const MAX_PREVIEW_CHARS = 400;

function normalizePath(rawPath: string, cwd: string): string {
	// agy on Windows sometimes prefixes absolute paths with a leading slash ("/C:/...").
	let p = rawPath.trim();
	if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
	const rel = path.relative(cwd, p);
	if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
		return rel.replace(/\\/g, "/");
	}
	return p.replace(/\\/g, "/");
}

function singleLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function stripControlChars(text: string): string {
	// Strip ANSI escapes and non-printable control chars (keep newlines for multi-line previews).
	return text
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function resolveVerb(kind?: string, name?: string): string {
	switch (kind) {
		case "read":
			return "read";
		case "edit":
			return name === "write_file" ? "write" : "edit";
		case "execute":
			return "bash";
		case "search":
			return "search";
		case "fetch":
			return "fetch";
		case "delete":
			return "delete";
	}
	if (name) {
		const map: Record<string, string> = {
			read_file: "read",
			edit_file: "edit",
			write_file: "write",
			run_command: "bash",
			grep_search: "search",
			find_by_name: "find",
			search_web: "web",
		};
		return map[name] ?? name;
	}
	return kind || "tool";
}

function extractTarget(u: any, cwd: string): string | undefined {
	const input = (u.rawInput && typeof u.rawInput === "object" ? u.rawInput : u.args) as Record<string, any> | undefined;
	if (typeof input?.CommandLine === "string" && input.CommandLine.trim()) {
		return singleLine(input.CommandLine);
	}
	if (typeof input?.command === "string" && input.command.trim()) {
		return singleLine(input.command);
	}

	const rawPath: string | undefined =
		(typeof input?.Path === "string" && input.Path) ||
		(typeof input?.path === "string" && input.path) ||
		(typeof u.locations?.[0]?.path === "string" && u.locations[0].path) ||
		undefined;
	if (rawPath) {
		const display = normalizePath(rawPath, cwd);
		const start = typeof input?.StartLine === "number" ? input.StartLine : undefined;
		const end = typeof input?.EndLine === "number" ? input.EndLine : undefined;
		if (start !== undefined && end !== undefined) return `${display}:${start}-${end}`;
		if (start !== undefined) return `${display}:${start}`;
		return display;
	}

	if (typeof input?.Query === "string" && input.Query.trim()) return singleLine(input.Query);
	if (typeof input?.query === "string" && input.query.trim()) return singleLine(input.query);
	if (typeof input?.Pattern === "string" && input.Pattern.trim()) return singleLine(input.Pattern);
	return undefined;
}

function formatDisplayTitle(rawTitle: unknown, cwd: string): string | undefined {
	if (typeof rawTitle !== "string" || !rawTitle.trim()) return undefined;
	const cleaned = rawTitle.replace(/^File\s+/, "");
	return /^(\/?[A-Za-z]:[\\/]|\/)/.test(cleaned) ? normalizePath(cleaned, cwd) : singleLine(cleaned);
}

function extractOutputPreview(u: any): string | undefined {
	let raw = "";
	if (typeof u.rawOutput?.output === "string") {
		raw = u.rawOutput.output;
	} else if (typeof u.rawOutput === "string") {
		raw = u.rawOutput;
	} else if (Array.isArray(u.content)) {
		const chunks: string[] = [];
		for (const item of u.content) {
			if (item?.type === "content" && item.content?.type === "text" && typeof item.content.text === "string") {
				chunks.push(item.content.text);
			} else if (item?.type === "text" && typeof item.text === "string") {
				chunks.push(item.text);
			}
		}
		raw = chunks.join("\n");
	}
	if (!raw) return undefined;

	// Strip agy's run_command header boilerplate so previews focus on actual command output.
	const cleaned = stripControlChars(raw)
		.replace(/\r\n/g, "\n")
		.replace(/^(?:Created At:.*\n|Completed At:.*\n|Command exited with code -?\d+\.\n|\n)+/, "")
		.replace(/^Command output:\n/, "")
		.trim();
	if (!cleaned) return undefined;

	const lines = cleaned.split("\n");
	const kept = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
	const clipped = kept.length > MAX_PREVIEW_CHARS ? `${kept.slice(0, MAX_PREVIEW_CHARS - 1)}…` : kept;
	return lines.length > MAX_PREVIEW_LINES && !clipped.endsWith("…")
		? `${clipped}\n… (+${lines.length - MAX_PREVIEW_LINES} lines)`
		: clipped;
}

export function upsertAcpToolRecord(
	tools: AgyToolRecord[],
	update: any,
	cwd: string,
	startedAtMap: Map<string, number>,
): void {
	const id = String(update.toolCallId ?? "");
	const rawName = typeof update.name === "string" && update.name ? update.name : undefined;
	const rawKind = typeof update.kind === "string" && update.kind ? update.kind : undefined;
	const rawTitle = formatDisplayTitle(update.title, cwd);
	const rawStatus = typeof update.status === "string" && update.status ? update.status : undefined;
	const target = extractTarget(update, cwd);
	const exitCode = typeof update.rawOutput?.exit_code === "number" ? update.rawOutput.exit_code : undefined;
	const outputPreview = extractOutputPreview(update);

	let record = id ? tools.find((t) => t.id === id) : undefined;
	const now = Date.now();
	if (!record) {
		if (id) startedAtMap.set(id, now);
		record = {
			id,
			title: rawTitle || rawName || "tool",
			...(rawName ? { name: rawName } : {}),
			...(rawKind ? { kind: rawKind } : {}),
			status: rawStatus || "in_progress",
			...(target ? { target } : {}),
		};
		tools.push(record);
	} else {
		if (rawTitle) record.title = rawTitle;
		if (rawName) record.name = rawName;
		if (rawKind) record.kind = rawKind;
		if (rawStatus) record.status = rawStatus;
		if (target) record.target = target;
	}

	if (exitCode !== undefined) record.exitCode = exitCode;
	if (outputPreview !== undefined) record.outputPreview = outputPreview;
	if (record.status === "completed" || record.status === "failed") {
		const start = id ? startedAtMap.get(id) : undefined;
		if (start !== undefined && record.durationMs === undefined) {
			record.durationMs = Math.max(0, now - start);
		}
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatToolRow(
	t: AgyToolRecord,
	theme: Theme,
	spinnerFrame?: string,
	showDuration = false,
): string {
	const isFailed = t.status === "failed" || (t.exitCode !== undefined && t.exitCode !== 0);
	const isDone = t.status === "completed" || t.status === "failed";
	const icon = isFailed
		? theme.fg("error", "✗")
		: isDone
			? theme.fg("success", "✓")
			: theme.fg("warning", spinnerFrame ?? "…");

	const verb = resolveVerb(t.kind, t.name).padEnd(6);
	const target = t.target || t.title;
	const meta: string[] = [];
	if (t.exitCode !== undefined && t.exitCode !== 0) {
		meta.push(theme.fg("error", `exit ${t.exitCode}`));
	} else if (t.exitCode === 0 && showDuration) {
		meta.push(theme.fg("dim", "exit 0"));
	}
	if (showDuration && t.durationMs !== undefined) {
		meta.push(theme.fg("dim", formatDuration(t.durationMs)));
	}
	const suffix = meta.length > 0 ? `  ${meta.join(" · ")}` : "";
	return `  ${icon} ${theme.fg("toolTitle", verb)} ${theme.fg("accent", target)}${suffix}`;
}

function makeBgFn(theme: Theme, token: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"): (s: string) => string {
	// `truncateToWidth` emits `\x1b[0m` before/after `...`, which clears Box's background unless re-applied.
	const marker = "\x00";
	const bgAnsi = theme.bg(token, marker).split(marker)[0] ?? "";
	if (!bgAnsi) return (s) => theme.bg(token, s);
	return (s) => theme.bg(token, s.replace(/\x1b\[0m/g, `\x1b[0m${bgAnsi}`));
}

export function createLiveToolWidget(tui: TUI, theme: Theme, state: LiveToolTurnState): LiveToolWidgetComponent {
	let frame = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let cachedBox: Box | undefined;

	const hasActiveTool = () => state.tools.some((t) => t.status !== "completed" && t.status !== "failed");

	const syncTimer = () => {
		if (hasActiveTool() && !timer) {
			timer = setInterval(() => {
				frame = (frame + 1) % SPINNER_FRAMES.length;
				cachedBox = undefined;
				tui.requestRender();
			}, 100);
		} else if (!hasActiveTool() && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	const buildBox = (): Box => {
		const box = new Box(1, 1, makeBgFn(theme, "toolPendingBg"));
		const running = hasActiveTool();
		const spinner = SPINNER_FRAMES[frame]!;
		const total = state.tools.length;
		const done = state.tools.filter((t) => t.status === "completed" || t.status === "failed").length;
		const elapsed = formatDuration(Math.max(0, Date.now() - state.startedAt));

		const headerIcon = running ? theme.fg("warning", spinner) : theme.fg("success", "✓");
		const countText = total > 0 ? `${done}/${total} ${total === 1 ? "tool" : "tools"}` : "working";
		const header = `${headerIcon} ${theme.fg("toolTitle", theme.bold("agy"))} ${theme.fg("dim", `· ${countText} · ${elapsed}`)}`;
		box.addChild(new TruncatedText(header, 0, 0));

		const shown = state.tools.slice(-MAX_LIVE_ROWS);
		if (state.tools.length > shown.length) {
			box.addChild(new TruncatedText(theme.fg("dim", `  … ${state.tools.length - shown.length} earlier actions`), 0, 0));
		}
		for (const t of shown) {
			box.addChild(new TruncatedText(formatToolRow(t, theme, spinner, true), 0, 0));
		}
		if (state.plan.length > 0) {
			const pDone = state.plan.filter((p) => p.status === "completed").length;
			const active = state.plan.find((p) => p.status === "in_progress");
			const planText = `  ${theme.fg("muted", `plan ${pDone}/${state.plan.length}`)}${active ? theme.fg("dim", ` · ${singleLine(active.content)}`) : ""}`;
			box.addChild(new TruncatedText(planText, 0, 0));
		}
		return box;
	};

	syncTimer();

	return {
		update() {
			syncTimer();
			cachedBox = undefined;
			tui.requestRender();
		},
		invalidate() {
			cachedBox = undefined;
		},
		render(width: number): string[] {
			if (!cachedBox) cachedBox = buildBox();
			return [...cachedBox.render(width)];
		},
		dispose() {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			cachedBox = undefined;
		},
	};
}

export function renderAgyActionsEntry(
	data: AgyActionsEntryData | undefined,
	options: EntryRenderOptions,
	theme: Theme,
): Component | undefined {
	const tools = data?.tools;
	if (!tools || tools.length === 0) return undefined;

	const totalCount = Math.max(data.totalCount ?? tools.length, tools.length);
	const isFailed = (t: AgyToolRecord) => t.status === "failed" || (t.exitCode !== undefined && t.exitCode !== 0);
	const failedCount = tools.filter(isFailed).length;
	const completedCount = tools.filter((t) => !isFailed(t) && t.status === "completed").length;
	const allFailed = failedCount === totalCount;
	const allCompleted = completedCount === totalCount;
	const bgToken = allFailed ? "toolErrorBg" : allCompleted ? "toolSuccessBg" : "toolPendingBg";
	const box = new Box(1, 1, makeBgFn(theme, bgToken));

	const icon = allFailed
		? theme.fg("error", "✗")
		: allCompleted
			? theme.fg("success", "✓")
			: theme.fg("warning", "…");
	const countLabel = `${totalCount} ${totalCount === 1 ? "action" : "actions"}`;
	const failedPart = failedCount > 0 && !allFailed ? ` ${theme.fg("warning", `(${failedCount} failed)`)}` : "";
	const durationPart = data.durationMs !== undefined ? ` · ${formatDuration(data.durationMs)}` : "";
	const hasExpandableDetail =
		totalCount > MAX_COLLAPSED_ROWS || tools.some((t) => Boolean(t.outputPreview) || t.durationMs !== undefined);
	const hint = !options.expanded && hasExpandableDetail ? `  ${theme.fg("dim", `(${options.keyHint("app.tools.expand", "to expand")})`)}` : "";

	const header = `${icon} ${theme.fg("toolTitle", theme.bold("agy"))} ${theme.fg("muted", `· ${countLabel}`)}${failedPart}${theme.fg("muted", durationPart)}${hint}`;
	box.addChild(new TruncatedText(header, 0, 0));

	const shown = options.expanded ? tools : tools.slice(0, MAX_COLLAPSED_ROWS);
	for (const t of shown) {
		box.addChild(new TruncatedText(formatToolRow(t, theme, undefined, options.expanded), 0, 0));
		if (options.expanded && t.outputPreview) {
			for (const line of t.outputPreview.split("\n")) {
				box.addChild(new TruncatedText(`    ${theme.fg("borderMuted", "│")} ${theme.fg("toolOutput", line)}`, 0, 0));
			}
		}
	}

	if (!options.expanded && totalCount > shown.length) {
		box.addChild(new TruncatedText(theme.fg("dim", `  … +${totalCount - shown.length} more`), 0, 0));
	} else if (options.expanded && totalCount > tools.length) {
		box.addChild(new TruncatedText(theme.fg("dim", `  … (+${totalCount - tools.length} more actions not stored)`), 0, 0));
	}

	return box;
}
