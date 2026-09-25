import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const TRACE_NAME = /^call-\d+-[0-9a-f-]{36}\.jsonl$/;

export function rawTraceRoot(sessionFile: string): string {
	const sessions = `${path.sep}sessions${path.sep}`;
	const index = sessionFile.lastIndexOf(sessions);
	const agentDir = index >= 0 ? sessionFile.slice(0, index) : path.dirname(sessionFile);
	return path.join(agentDir, "raw-calls");
}

export async function pruneRawTraces(root: string, now = Date.now()): Promise<void> {
	const names = await readdir(root).catch(() => []);
	for (const name of names) {
		if (!TRACE_NAME.test(name)) continue;
		const target = path.join(root, name);
		const info = await stat(target).catch(() => undefined);
		if (info?.isFile() && now - info.mtimeMs > RETAIN_MS) await unlink(target).catch(() => undefined);
	}
}

export class RawCallTrace {
	readonly path: string;
	#queue: unknown[] = [];
	#tail: Promise<void> = Promise.resolve();
	#scheduled = false;
	#failed: string | null = null;
	#closed = false;
	#onFailure: (error: string) => void;

	constructor(sessionFile: string, onFailure: (error: string) => void = () => undefined) {
		const root = rawTraceRoot(sessionFile);
		this.path = path.join(root, `call-${Date.now()}-${randomUUID()}.jsonl`);
		this.#onFailure = onFailure;
		this.record("start", { sessionFile });
	}

	record(kind: string, value: unknown): void {
		if (this.#closed || this.#failed) return;
		try {
			this.#queue.push({ at: Date.now(), kind, value });
			if (this.#queue.length >= 64) this.#schedule();
		} catch (error) {
			this.#failed = String(error);
			this.#queue = [];
			try { this.#onFailure(this.#failed); } catch { /* Observation must not fail inference. */ }
		}
	}

	finish(value: unknown): string {
		this.record("complete", value);
		this.#closed = true;
		try { this.#schedule(); } catch (error) {
			this.#failed = String(error);
			try { this.#onFailure(this.#failed); } catch { /* Observation must not fail inference. */ }
		}
		return this.path;
	}

	async settled(): Promise<{ path: string; failure: string | null }> {
		this.#schedule();
		await new Promise<void>(resolve => setImmediate(resolve));
		await this.#tail;
		return { path: this.path, failure: this.#failed };
	}

	#schedule(): void {
		if (this.#scheduled || this.#queue.length === 0 || this.#failed) return;
		this.#scheduled = true;
		setImmediate(() => {
			this.#scheduled = false;
			const batch = this.#queue.splice(0);
			this.#tail = this.#tail.then(async () => {
				await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
				await appendFile(this.path, batch.map(item => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
			}).catch(error => {
				this.#failed = String(error);
				this.#queue = [];
				try { this.#onFailure(this.#failed); } catch { /* Observation must not fail inference. */ }
			});
		});
	}
}
