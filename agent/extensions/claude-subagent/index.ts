import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const OutputMode = StringEnum(["json", "stream-json"] as const, {
	description: "How to read Claude output. stream-json provides partial updates.",
	default: "json",
});

const ClaudeSubagentParams = Type.Object({
	task: Type.String({ description: "Task to delegate to Claude Code." }),
	thread: Type.Optional(
		Type.String({
			description:
				"Optional thread key. If provided, the extension remembers the latest Claude session_id for this thread.",
		}),
	),
	sessionId: Type.Optional(
		Type.String({
			description: "Resume a specific Claude session ID (maps to claude --resume).",
		}),
	),
	continueRecent: Type.Optional(
		Type.Boolean({
			description: "Continue Claude's most recent session (maps to claude --continue).",
			default: false,
		}),
	),
	allowedTools: Type.Optional(
		Type.String({
			description:
				'Claude --allowedTools value. Default: "Read,Edit,Bash". Example: "Read,Edit,Bash(git diff *)"',
		}),
	),
	appendSystemPrompt: Type.Optional(
		Type.String({
			description: "Optional Claude --append-system-prompt text.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the Claude subprocess." })),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: "Optional timeout in seconds. Kills Claude if exceeded.",
			minimum: 1,
		}),
	),
	mode: Type.Optional(OutputMode),
	cliPath: Type.Optional(
		Type.String({
			description: "Claude CLI executable path. Defaults to CLAUDE_CLI_PATH env var or 'claude'.",
		}),
	),
});

function tryParseJson(text: string): any | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		// Some CLIs print extra lines. Try last parseable line.
		const lines = trimmed
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				return JSON.parse(lines[i]);
			} catch {
				// continue
			}
		}
		return undefined;
	}
}

function extractSessionId(value: any): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const direct = value.session_id ?? value.sessionId;
	if (typeof direct === "string" && direct.length > 0) return direct;

	const candidates = [
		value.metadata?.session_id,
		value.metadata?.sessionId,
		value.event?.session_id,
		value.event?.sessionId,
		value.result?.session_id,
		value.result?.sessionId,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

function extractResultText(value: any): string {
	if (!value || typeof value !== "object") return "";
	const candidates = [
		value.result,
		value.output,
		value.text,
		value.response,
		value.structured_output,
		value.message,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string") return candidate;
		if (candidate && typeof candidate === "object") return JSON.stringify(candidate, null, 2);
	}
	return "";
}

function extractTextDelta(event: any): string | undefined {
	if (!event || typeof event !== "object") return undefined;

	const delta = event.event?.delta;
	if (delta?.type === "text_delta" && typeof delta.text === "string") return delta.text;

	if (event.assistantMessageEvent?.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string") {
		return event.assistantMessageEvent.delta;
	}

	if (event.type === "text_delta" && typeof event.text === "string") return event.text;
	return undefined;
}

function writeTruncatedTempFile(prefix: string, content: string): string | undefined {
	try {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
		const filePath = path.join(dir, "full-output.txt");
		fs.writeFileSync(filePath, content, "utf8");
		return filePath;
	} catch {
		return undefined;
	}
}

function truncateForModel(text: string): { text: string; truncated: boolean; fullOutputPath?: string } {
	const truncation = truncateTail(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});

	if (!truncation.truncated) {
		return { text: truncation.content, truncated: false };
	}

	const fullOutputPath = writeTruncatedTempFile("pi-claude-subagent", text);
	let message = truncation.content;
	message += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
	message += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
	if (fullOutputPath) message += ` Full output saved to: ${fullOutputPath}`;
	message += "]";

	return { text: message, truncated: true, fullOutputPath };
}

export default function (pi: ExtensionAPI) {
	const threadToSession = new Map<string, string>();

	pi.on("session_start", async (_event, ctx) => {
		threadToSession.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			if (entry.message.toolName !== "claude_subagent") continue;
			const details = entry.message.details as any;
			if (typeof details?.thread === "string" && typeof details?.sessionId === "string") {
				threadToSession.set(details.thread, details.sessionId);
			}
		}
	});

	pi.registerTool({
		name: "claude_subagent",
		label: "Claude Subagent",
		description:
			"Delegate a task to Claude Code (claude -p) and return the result. Supports thread-based session reuse, --resume/--continue, and --allowedTools.",
		parameters: ClaudeSubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cliPath = params.cliPath || process.env.CLAUDE_CLI_PATH || "claude";
			const workingDir = params.cwd || ctx.cwd;
			const mode = (params.mode || "json") as "json" | "stream-json";
			const allowedTools = params.allowedTools || "Read,Edit,Bash";

			const rememberedSessionId = params.thread ? threadToSession.get(params.thread) : undefined;
			const resumeSessionId = params.sessionId || rememberedSessionId;

			if (resumeSessionId && params.continueRecent) {
				return {
					content: [
						{ type: "text", text: "Invalid parameters: use either sessionId/resolved thread OR continueRecent, not both." },
					],
					details: {},
					isError: true,
				};
			}

			const args: string[] = ["-p", params.task];
			if (mode === "stream-json") {
				args.push("--output-format", "stream-json", "--verbose", "--include-partial-messages");
			} else {
				args.push("--output-format", "json");
			}
			if (allowedTools) args.push("--allowedTools", allowedTools);
			if (params.appendSystemPrompt) args.push("--append-system-prompt", params.appendSystemPrompt);
			if (resumeSessionId) args.push("--resume", resumeSessionId);
			else if (params.continueRecent) args.push("--continue");

			const commandPreview = `${cliPath} ${args.join(" ")}`;
			let stdout = "";
			let stderr = "";
			let parsedObjects: any[] = [];
			let streamText = "";
			let effectiveSessionId: string | undefined = resumeSessionId;
			let timeoutId: NodeJS.Timeout | undefined;

			try {
				const exitCode = await new Promise<number>((resolve) => {
					const proc = spawn(cliPath, args, {
						cwd: workingDir,
						env: process.env,
						shell: false,
						stdio: ["ignore", "pipe", "pipe"],
					});

					let lineBuffer = "";
					let finished = false;

					const killProcess = () => {
						if (finished) return;
						try {
							proc.kill("SIGTERM");
						} catch {
							// ignore
						}
						setTimeout(() => {
							if (!proc.killed) {
								try {
									proc.kill("SIGKILL");
								} catch {
									// ignore
								}
							}
						}, 3000);
					};

					if (params.timeoutSeconds && params.timeoutSeconds > 0) {
						timeoutId = setTimeout(killProcess, params.timeoutSeconds * 1000);
					}

					if (signal) {
						if (signal.aborted) killProcess();
						signal.addEventListener("abort", killProcess, { once: true });
					}

					const processLine = (line: string) => {
						const trimmed = line.trim();
						if (!trimmed) return;
						const parsed = tryParseJson(trimmed);
						if (!parsed) return;
						parsedObjects.push(parsed);
						const sid = extractSessionId(parsed);
						if (sid) effectiveSessionId = sid;

						if (mode === "stream-json") {
							const delta = extractTextDelta(parsed);
							if (delta) {
								streamText += delta;
								onUpdate?.({
									content: [{ type: "text", text: streamText.slice(-4000) || "(streaming...)" }],
									details: { sessionId: effectiveSessionId, mode },
								});
							}
						}
					};

					proc.stdout.on("data", (chunk) => {
						const text = chunk.toString();
						stdout += text;
						lineBuffer += text;
						const lines = lineBuffer.split(/\r?\n/);
						lineBuffer = lines.pop() || "";
						for (const line of lines) processLine(line);
					});

					proc.stderr.on("data", (chunk) => {
						stderr += chunk.toString();
					});

					proc.on("error", (err) => {
						stderr += `${err.message}\n`;
						finished = true;
						resolve(1);
					});

					proc.on("close", (code) => {
						finished = true;
						if (lineBuffer.trim()) processLine(lineBuffer);
						resolve(code ?? 0);
					});
				});

				if (timeoutId) clearTimeout(timeoutId);

				if (params.thread && effectiveSessionId) {
					threadToSession.set(params.thread, effectiveSessionId);
				}

				if (exitCode !== 0) {
					const errorText = stderr.trim() || stdout.trim() || `Claude exited with code ${exitCode}.`;
					return {
						content: [{ type: "text", text: `claude_subagent failed:\n${errorText}` }],
						details: {
							exitCode,
							command: commandPreview,
							cwd: workingDir,
							sessionId: effectiveSessionId,
							thread: params.thread,
							stdout: stdout.slice(-5000),
							stderr: stderr.slice(-5000),
						},
						isError: true,
					};
				}

				let rawResultText = "";
				let topLevel: any = undefined;

				if (mode === "json") {
					topLevel = tryParseJson(stdout);
					if (topLevel) {
						effectiveSessionId = extractSessionId(topLevel) || effectiveSessionId;
						rawResultText = extractResultText(topLevel);
					}
				}

				if (!effectiveSessionId && parsedObjects.length > 0) {
					for (let i = parsedObjects.length - 1; i >= 0; i--) {
						const sid = extractSessionId(parsedObjects[i]);
						if (sid) {
							effectiveSessionId = sid;
							break;
						}
					}
				}

				if (!rawResultText && mode === "stream-json") {
					rawResultText = streamText;
				}
				if (!rawResultText && parsedObjects.length > 0) {
					rawResultText = extractResultText(parsedObjects[parsedObjects.length - 1]);
				}
				if (!rawResultText) {
					rawResultText = stdout.trim() || "(Claude returned no text output)";
				}

				const truncated = truncateForModel(rawResultText);

				return {
					content: [{ type: "text", text: truncated.text }],
					details: {
						exitCode,
						mode,
						command: commandPreview,
						cwd: workingDir,
						sessionId: effectiveSessionId,
						thread: params.thread,
						usedResume: Boolean(resumeSessionId),
						usedContinue: Boolean(params.continueRecent),
						allowedTools,
						truncated: truncated.truncated,
						fullOutputPath: truncated.fullOutputPath,
						raw: mode === "json" ? topLevel : undefined,
					},
				};
			} catch (error: any) {
				if (timeoutId) clearTimeout(timeoutId);
				return {
					content: [
						{
							type: "text",
							text:
								`claude_subagent error: ${error?.message || "Unknown error"}. ` +
								`Make sure Claude Code CLI is installed and available as \"${cliPath}\".`,
						},
					],
					details: {
						command: commandPreview,
						cwd: workingDir,
						sessionId: effectiveSessionId,
						thread: params.thread,
						stderr: stderr.slice(-5000),
						stdout: stdout.slice(-5000),
					},
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("claude", {
		description: "Run Claude Code directly: /claude <task>",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /claude <task>", "warning");
				return;
			}
			pi.sendUserMessage(`Use claude_subagent with task: ${args.trim()}`);
		},
	});
}
