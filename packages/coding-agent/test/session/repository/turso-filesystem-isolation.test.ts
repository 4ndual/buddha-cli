import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

interface SentinelSnapshot {
	sha256: string;
	size: number;
	mtimeMs: number;
	mode: number;
}

async function snapshotSentinel(filePath: string): Promise<SentinelSnapshot> {
	const [bytes, stat] = await Promise.all([Bun.file(filePath).arrayBuffer(), fs.stat(filePath)]);
	return {
		sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		mode: stat.mode,
	};
}

describe("Turso filesystem isolation", () => {
	it("starts JSONL controls with the native package poisoned and performs zero JSONL archive syscalls", async () => {
		using temp = TempDir.createSync("@omp-turso-fs-trace-");
		const jsonlRoot = path.join(temp.path(), "jsonl-archive-sentinel");
		const sentinelPath = path.join(jsonlRoot, "must-not-touch.jsonl");
		const childPath = path.join(temp.path(), "jsonl-startup.ts");
		const activeJsonlRoot = path.join(temp.path(), "active-jsonl");
		const tracePath = path.join(temp.path(), "filesystem.trace");
		await fs.mkdir(jsonlRoot, { recursive: true });
		await Bun.write(sentinelPath, '{"type":"session","id":"sentinel"}\n');
		const before = await snapshotSentinel(sentinelPath);
		const storageModule = path.resolve(import.meta.dir, "../../../src/cli/storage/index.ts");
		const repositoryModule = path.resolve(import.meta.dir, "../../../src/session/repository/index.ts");
		await Bun.write(
			childPath,
			`Bun.plugin({
	setup(builder) {
		builder.onResolve({ filter: /^@tursodatabase\\/database$/ }, args => ({ path: args.path, namespace: "blocked-turso" }));
		builder.onLoad({ filter: /.*/, namespace: "blocked-turso" }, () => ({
			contents: 'throw new Error("native Turso driver must not load in JSONL mode")',
			loader: "js",
		}));
	},
});
// The plugin must be installed before the runtime-selected module loads so this cannot be a static import.
const { runStorageCommand } = await import(${JSON.stringify(storageModule)});
const { createSessionRepository } = await import(${JSON.stringify(repositoryModule)});
const deps = {
	writeStdout() {},
	async loadMigrationController() { throw new Error("migration controller must stay lazy"); },
	async previewModeTransition() { return { message: "preview", details: { configurationMutated: false } }; },
};
const status = await runStorageCommand({ action: "status", machine: true }, deps);
if (status.outcome !== "ok" || status.status?.activeMode !== "jsonl") throw new Error("JSONL status unavailable");
const mode = await runStorageCommand({ action: "mode", requestedMode: "jsonl" }, deps);
let adapterLoads = 0;
const repository = await createSessionRepository({
	mode: "jsonl",
	rootDir: ${JSON.stringify(activeJsonlRoot)},
	replicaId: "replica:jsonl-startup",
	modeGeneration: 0,
	loadAdapter: async () => {
		adapterLoads += 1;
		throw new Error("database adapter must stay lazy");
	},
});
const health = await repository.health();
if (health.status !== "ok" || repository.mode !== "jsonl" || adapterLoads !== 0) throw new Error("JSONL repository unavailable");
await repository.close();
if (mode.outcome !== "preview") throw new Error("JSONL mode preview unavailable");
`,
		);

		const subprocess = Bun.spawn(
			["strace", "-f", "-qq", "-e", "trace=%file", "-o", tracePath, process.execPath, childPath],
			{ cwd: temp.path(), stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			subprocess.exited,
			new Response(subprocess.stdout).text(),
			new Response(subprocess.stderr).text(),
		]);
		expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });

		const trace = await Bun.file(tracePath).text();
		expect(trace).not.toContain(jsonlRoot);
		expect(trace).not.toContain("@tursodatabase/database");
		expect(await snapshotSentinel(sentinelPath)).toEqual(before);
	});

	it("runs ordinary DB repository reads, payload streaming, health, and flush with zero JSONL archive syscalls", async () => {
		using temp = TempDir.createSync("@omp-turso-db-fs-trace-");
		const jsonlRoot = path.join(temp.path(), "jsonl-archive-sentinel");
		const sentinelPath = path.join(jsonlRoot, "must-not-touch.jsonl");
		const childPath = path.join(temp.path(), "db-ordinary-operations.ts");
		const tracePath = path.join(temp.path(), "db-filesystem.trace");
		await fs.mkdir(jsonlRoot, { recursive: true });
		await Bun.write(sentinelPath, '{"type":"session","id":"db-sentinel"}\n');
		const before = await snapshotSentinel(sentinelPath);
		const repositoryModule = path.resolve(import.meta.dir, "../../../src/session/repository/turso/repository.ts");
		await Bun.write(
			childPath,
			`import { createTursoSessionRepository } from ${JSON.stringify(repositoryModule)};
const adapter = {
	replicaId: "replica:trace",
	async transaction(work) { return work(this); },
	async listSessions() { return []; },
	async search() { return []; },
	async readTree() { return []; },
	async readEvents() { return []; },
	async listRelatedResources() { return []; },
	async getHeader() { return undefined; },
	async *readContextTail() {},
	async writePayload() { return { payloadHash: "payload:trace", byteLength: 3 }; },
	async *readPayload() { yield new Uint8Array([1, 2, 3]); },
	async resolveRelatedResource() { return undefined; },
	async getTerminalSessionPointer() { return undefined; },
	async listPinned() { return []; },
	async health() { return { status: "ok", writable: true, modeGeneration: 1 }; },
	async flush(expectedModeGeneration) {
		return { modeGeneration: expectedModeGeneration, committedSequence: "trace-1", durable: true };
	},
	async close() {},
};
const repository = createTursoSessionRepository({ adapter, defaultPageSize: 2, maxPageSize: 2 });
await repository.listSessions({ limit: 2 });
await repository.search({ text: "needle", limit: 2 });
await repository.readTree({ branchId: "branch-main", limit: 2 });
await repository.getHeader({ branchId: "branch-main" });
for await (const _event of repository.readContextTail({ branchId: "branch-main", maxEntries: 2 })) {}
for await (const _chunk of repository.readPayload({ payloadHash: "payload-1" })) {}
await repository.health();
await repository.flush({ expectedModeGeneration: 1 });
await repository.close();
`,
		);

		const subprocess = Bun.spawn(
			["strace", "-f", "-qq", "-e", "trace=%file", "-o", tracePath, process.execPath, childPath],
			{ cwd: temp.path(), stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			subprocess.exited,
			new Response(subprocess.stdout).text(),
			new Response(subprocess.stderr).text(),
		]);
		expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
		const trace = await Bun.file(tracePath).text();
		expect(trace).not.toContain(jsonlRoot);
		expect(await snapshotSentinel(sentinelPath)).toEqual(before);
	});

	it("routes manager, memory, stats, history, title, activity, Hub, and RPC consumers without session JSONL", async () => {
		using temp = TempDir.createSync("@omp-turso-consumer-fs-trace-");
		const jsonlRoot = path.join(temp.path(), "jsonl-archive-sentinel");
		const sentinelPath = path.join(jsonlRoot, "must-not-touch.jsonl");
		const childPath = path.join(temp.path(), "repository-consumers.test.ts");
		const tracePath = path.join(temp.path(), "consumer-filesystem.trace");
		await fs.mkdir(jsonlRoot, { recursive: true });
		await Bun.write(sentinelPath, '{"type":"session","id":"consumer-sentinel"}\n');
		const before = await snapshotSentinel(sentinelPath);
		const activityModule = path.resolve(import.meta.dir, "../../../src/activity/index.ts");
		const historyModule = path.resolve(import.meta.dir, "../../../src/history/index.ts");
		const memoryModule = path.resolve(import.meta.dir, "../../../src/memories/index.ts");
		const managerModule = path.resolve(import.meta.dir, "../../../src/session/session-manager.ts");
		const repositoryConsumersModule = path.resolve(import.meta.dir, "../../../src/session/repository-consumers.ts");
		const rpcSubagentsModule = path.resolve(import.meta.dir, "../../../src/modes/rpc/rpc-subagents.ts");
		const titleModule = path.resolve(import.meta.dir, "../../../src/session/title-index.ts");
		const rpcClientModule = path.resolve(import.meta.dir, "../../../src/modes/rpc/rpc-client.ts");
		const rpcModeModule = path.resolve(import.meta.dir, "../../../src/modes/rpc/rpc-mode.ts");
		const statsModule = path.resolve(import.meta.dir, "../../../../stats/src/repository.ts");
		await Bun.write(
			childPath,
			`import { AgentActivityIndex } from ${JSON.stringify(activityModule)};
import { RepositoryHistoryProjection } from ${JSON.stringify(historyModule)};
import { collectRepositoryMemoryThreads } from ${JSON.stringify(memoryModule)};
import { SessionManager } from ${JSON.stringify(managerModule)};
import { readRepositoryTranscriptPage } from ${JSON.stringify(repositoryConsumersModule)};
import { RepositorySessionTitleIndex } from ${JSON.stringify(titleModule)};
import { streamRepositoryStats } from ${JSON.stringify(statsModule)};
const header = {
	originId: "origin:trace",
	branchId: "branch:trace",
	versionId: "version:trace",
	sourceAlias: "source:trace",
	replicaId: "replica:trace",
	headEventHash: "event:trace",
	forkPointHash: null,
	parentVersionId: null,
	generation: 1,
	metadata: { title: "Trace", createdAt: "2026-09-15T00:00:00.000Z", cwd: "/team/fixture" },
	modifiedAt: "2026-09-15T00:00:01.000Z",
};
const event = {
	eventHash: "event:trace",
	originId: "origin:trace",
	parentEventHash: null,
	nativeEntryId: "entry:trace",
	generation: 1,
	entry: {
		type: "message",
		id: "entry:trace",
		parentId: null,
		timestamp: "2026-09-15T00:00:01.000Z",
		message: { role: "user", content: "trace prompt", timestamp: 1789430401000 },
	},
};
let repositoryCalls = 0;
const repository = {
	mode: "db",
	replicaId: "replica:trace",
	async listSessions() { repositoryCalls += 1; return { items: [header] }; },
	async readEvents() { repositoryCalls += 1; return { items: [event] }; },
	async getHeader() { repositoryCalls += 1; return header; },
	async search() { repositoryCalls += 1; return { items: [], nextCursor: undefined }; },
};
await SessionManager.listRepositoryPage(repository, { limit: 1 });
await collectRepositoryMemoryThreads(repository, { limit: 1, pageSize: 1 });
await new RepositorySessionTitleIndex({ repository }).list({ limit: 1, pageSize: 1 });
const history = new RepositoryHistoryProjection({ repository });
await history.recent({ limit: 1, sessionPageSize: 1, eventPageSize: 1 });
await history.search({ text: "trace", limit: 1 });
const activity = new AgentActivityIndex({
	repository,
	locateAgent: () => ({ branchId: "branch:trace", versionId: "version:trace" }),
	pageSize: 1,
});
await activity.sync("TraceAgent", ${JSON.stringify(sentinelPath)});
await import(${JSON.stringify(rpcClientModule)});
await import(${JSON.stringify(rpcModeModule)});
const { readRpcSubagentRepositoryTranscript } = await import(${JSON.stringify(rpcSubagentsModule)});
const source = { repository, locator: { branchId: "branch:trace", versionId: "version:trace" } };
await readRepositoryTranscriptPage(source, { limit: 1 });
await readRpcSubagentRepositoryTranscript(source);
for await (const _page of streamRepositoryStats(repository, { sessionPageSize: 1, eventPageSize: 1 })) {}
if (repositoryCalls < 10) throw new Error("repository consumers did not exercise the injected repository");
`,
		);
		const subprocess = Bun.spawn(
			["strace", "-f", "-qq", "-e", "trace=%file", "-o", tracePath, process.execPath, "test", childPath],
			{ cwd: temp.path(), stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			subprocess.exited,
			new Response(subprocess.stdout).text(),
			new Response(subprocess.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`consumer trace child failed (${exitCode})\n${stdout}\n${stderr}`);
		expect(exitCode).toBe(0);
		const trace = await Bun.file(tracePath).text();
		expect(trace).not.toContain(jsonlRoot);
		expect(await snapshotSentinel(sentinelPath)).toEqual(before);
	}, 20_000);
});
