import { Database } from "bun:sqlite";
import type { MetricReceipt } from "./types";
import { distribution, measureResources, memorySnapshot, sha256Text } from "./util";

interface ChildResult {
	kind: "writer" | "search";
	operations: number;
	bytes: number;
	latenciesMs: number[];
	maxRssBytes: number;
	error: string | null;
}
interface PipeChild {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}


function configure(database: Database): void {
	database.exec("PRAGMA journal_mode=WAL");
	database.exec("PRAGMA synchronous=FULL");
	database.exec("PRAGMA busy_timeout=5000");
	database.exec("PRAGMA cache_size=-32768");
}

export async function runConcurrencyChild(kind: "writer" | "search", databasePath: string, operations: number, byteCap: number): Promise<ChildResult> {
	const database = new Database(databasePath, { create: false, strict: true });
	configure(database);
	const latenciesMs: number[] = [];
	let completed = 0;
	let bytes = 0;
	let error: string | null = null;
	try {
		if (kind === "writer") {
			const insertEvent = database.prepare(
				"INSERT INTO events(id, origin_id, parent_id, kind, search_text, payload, sequence, created_at) VALUES (?, 'concurrent:writer', NULL, 'message', ?, ?, ?, ?)",
			);
			const insertSearch = database.prepare("INSERT INTO event_search(id, origin_id, search_text) VALUES (?, 'concurrent:writer', ?)");
			for (let index = 0; index < operations && bytes < byteCap; index++) {
				const text = `benchmark concurrent write ${index}`;
				const payload = new TextEncoder().encode(text.repeat(16));
				if (bytes + payload.byteLength > byteCap) break;
				const id = sha256Text(`concurrent:${index}`);
				const started = Bun.nanoseconds();
				const transaction = database.transaction(() => {
					insertEvent.run(id, text, payload, 2_000_000_000 + index, Date.now());
					insertSearch.run(id, text);
				});
				transaction();
				latenciesMs.push((Bun.nanoseconds() - started) / 1_000_000);
				completed++;
				bytes += payload.byteLength;
			}
		} else {
			const search = database.prepare(
				"SELECT id, origin_id, snippet(event_search, 2, '[', ']', '…', 24) AS snippet FROM event_search WHERE event_search MATCH 'benchmark' LIMIT 20",
			);
			for (let index = 0; index < operations; index++) {
				const started = Bun.nanoseconds();
				const rows = search.all();
				latenciesMs.push((Bun.nanoseconds() - started) / 1_000_000);
				completed++;
				bytes += JSON.stringify(rows).length;
				if (bytes >= byteCap) break;
			}
		}
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		database.close();
	}
	const memory = await memorySnapshot();
	return {
		kind,
		operations: completed,
		bytes,
		latenciesMs,
		maxRssBytes: memory.peakRssBytes ?? memory.rssBytes,
		error,
	};
}

async function childOutput(processHandle: PipeChild): Promise<ChildResult> {
	const stdout = await new Response(processHandle.stdout).text();
	const stderr = await new Response(processHandle.stderr).text();
	const exitCode = await processHandle.exited;
	if (exitCode !== 0) throw new Error(`concurrency child exited ${exitCode}: ${stderr.slice(0, 2000)}`);
	const parsed: unknown = JSON.parse(stdout);
	if (!parsed || typeof parsed !== "object" || !("kind" in parsed) || !("operations" in parsed)) {
		throw new Error("concurrency child returned an invalid result");
	}
	return parsed as ChildResult;
}

export async function runConcurrentWorkload(
	harnessPath: string,
	databasePath: string,
	operations: number,
	byteCap: number,
): Promise<MetricReceipt> {
	const measured = await measureResources(async () => {
		const common = [`--database=${databasePath}`, `--operations=${operations}`, `--byte-cap=${byteCap}`];
		const writer = Bun.spawn([process.execPath, harnessPath, "--child=writer", ...common], { stdout: "pipe", stderr: "pipe" });
		const search = Bun.spawn([process.execPath, harnessPath, "--child=search", ...common], { stdout: "pipe", stderr: "pipe" });
		return Promise.all([childOutput(writer), childOutput(search)]);
	});
	const [writer, search] = measured.value;
	const errors = [writer.error, search.error].filter((error): error is string => error !== null);
	const allLatencies = [...writer.latenciesMs, ...search.latenciesMs];
	const totalOperations = writer.operations + search.operations;
	const totalBytes = writer.bytes + search.bytes;
	return {
		status: errors.length === 0 && writer.operations > 0 && search.operations > 0 ? "measured" : "blocked",
		reason: errors.length > 0 ? errors.join("; ") : undefined,
		latency: distribution(allLatencies),
		resources: measured.resources,
		bridgeCalls: 0,
		operationCalls: totalOperations,
		rows: totalOperations,
		bytes: totalBytes,
		throughputRowsPerSecond: measured.elapsedMs === 0 ? 0 : (totalOperations * 1000) / measured.elapsedMs,
		throughputBytesPerSecond: measured.elapsedMs === 0 ? 0 : (totalBytes * 1000) / measured.elapsedMs,
		details: {
			writer: { operations: writer.operations, bytes: writer.bytes, maxRssBytes: writer.maxRssBytes, latency: distribution(writer.latenciesMs) },
			search: { operations: search.operations, bytes: search.bytes, maxRssBytes: search.maxRssBytes, latency: distribution(search.latenciesMs) },
		},
	};
}
