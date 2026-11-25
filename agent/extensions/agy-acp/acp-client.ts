/**
 * Minimal ACP (Agent Client Protocol) client over stdio JSON-RPC (NDJSON).
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };

export type NotificationHandler = (method: string, params: any) => void;
export type RequestHandler = (method: string, params: any) => Promise<any>;

export function resolveAgyBinary(): string {
	if (process.env.AGY_BIN) return process.env.AGY_BIN;
	const candidates =
		process.platform === "win32"
			? [path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe")]
			: [path.join(os.homedir(), ".local", "bin", "agy"), "/usr/local/bin/agy"];
	for (const c of candidates) if (fs.existsSync(c)) return c;
	return process.platform === "win32" ? "agy.exe" : "agy";
}

export class AcpClient {
	private proc: ChildProcess | undefined;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private stderrTail = "";
	private closed = false;
	initializeResult: any;

	onNotification: NotificationHandler = () => {};
	onRequest: RequestHandler = async (method) => {
		throw Object.assign(new Error(`Method not supported: ${method}`), { code: -32601 });
	};
	onExit: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void = () => {};

	constructor(
		private readonly bin: string,
		private readonly args: string[],
		private readonly cwd: string,
	) {}

	get isAlive(): boolean {
		return !!this.proc && !this.closed;
	}

	async start(): Promise<void> {
		const proc = spawn(this.bin, this.args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
		});
		this.proc = proc;
		proc.stdout!.setEncoding("utf8");
		proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
		proc.stderr!.setEncoding("utf8");
		proc.stderr!.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-4000);
		});
		// Swallow EPIPE if agy exits while we are writing a request or cancel notification.
		proc.stdin!.on("error", () => {});

		proc.on("error", (err) => {
			this.closed = true;
			this.failAll(new Error(`agy acp failed to start: ${err.message}`));
		});
		proc.on("close", (code, signal) => {
			this.closed = true;
			this.failAll(
				new Error(`agy acp exited (code=${code}, signal=${signal})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`),
			);
			this.onExit({ code, signal, stderr: this.stderrTail });
		});

		this.initializeResult = await this.request("initialize", {
			protocolVersion: 1,
			// agy executes its own local tools rather than delegating FS/terminal calls to the client.
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: "pi-agy-acp", version: "0.2.0" },
		});
	}

	request<T = any>(method: string, params: any): Promise<T> {
		if (!this.proc || this.closed) return Promise.reject(new Error("agy acp is not running"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, method });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: any): void {
		if (!this.proc || this.closed) return;
		this.write({ jsonrpc: "2.0", method, params });
	}

	kill(): void {
		if (!this.proc || this.closed) return;
		this.closed = true;
		this.failAll(new Error("agy acp client closed"));
		try {
			this.proc.stdin?.end();
		} catch {}
		try {
			this.proc.kill();
		} catch {}
	}

	private failAll(err: Error): void {
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
	}

	private write(msg: unknown): void {
		this.proc?.stdin?.write(`${JSON.stringify(msg)}\n`);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			this.dispatch(msg);
		}
	}

	private dispatch(msg: any): void {
		if (msg.id !== undefined && msg.method === undefined) {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) {
				const err = new Error(`${p.method}: ${msg.error.message ?? "error"} (${msg.error.code})`);
				(err as any).code = msg.error.code;
				(err as any).data = msg.error.data;
				p.reject(err);
			} else p.resolve(msg.result);
			return;
		}
		if (msg.id !== undefined && msg.method) {
			this.onRequest(msg.method, msg.params).then(
				(result) => this.write({ jsonrpc: "2.0", id: msg.id, result: result ?? null }),
				(err: any) =>
					this.write({
						jsonrpc: "2.0",
						id: msg.id,
						error: { code: typeof err?.code === "number" ? err.code : -32603, message: String(err?.message ?? err) },
					}),
			);
			return;
		}
		if (msg.method) {
			this.onNotification(msg.method, msg.params);
		}
	}
}
