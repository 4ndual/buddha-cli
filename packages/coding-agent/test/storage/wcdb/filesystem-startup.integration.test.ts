import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { hasWcdbTestAdapter, type JsonValue, WcdbMigrationTestDriver } from "./migration-test-driver";

interface FilesystemAccess extends Record<string, JsonValue> {
	syscall: "access" | "fstatat" | "getdents64" | "lstat" | "open" | "openat" | "stat" | "statx";
	path: string;
	operation: string;
}

interface TraceProbe extends Record<string, JsonValue> {
	ordinaryOperations: string[];
	accesses: FilesystemAccess[];
	results: Record<string, JsonValue>;
}

interface StartupProbe extends Record<string, JsonValue> {
	ready: boolean;
	selectedMode: "db" | "jsonl";
	nativeModuleLoaded: boolean;
	nativeLoadAttempted: boolean;
	jsonlOperationsCompleted: string[];
	databaseOpened: boolean;
	fallbackUsed: boolean;
	health: { ready: boolean; capability: string; errorCode?: string };
}

const fixture = path.resolve(import.meta.dir, "../../fixtures/wcdb/omp-v3-complete.jsonl");
const integrationIt = it.skipIf(!hasWcdbTestAdapter);

describe("WCDB mode filesystem isolation and startup", () => {
	integrationIt("traces DB ordinary operations and observes zero session JSONL stat/open/glob access", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-fs-trace-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const archive = path.join(workspace.path(), "jsonl-archive");
		await fs.mkdir(archive);
		await Bun.write(path.join(archive, "trap-session.jsonl"), Bun.file(fixture));
		await driver.invoke("reset", { mode: "db" });
		await driver.invoke("importArchive", {
			source: fixture,
			sourceNamespace: "omp-v3",
			replicaId: "trace-seed",
		});
		const expectedOperations = [
			"capabilities",
			"listSessions",
			"searchSessions",
			"listTree",
			"getHeader",
			"append",
			"fork",
			"writeContextCheckpoint",
			"readContextTail",
			"streamPayload",
			"flush",
			"health",
		];
		const trace = await driver.invoke<TraceProbe>("traceRepositoryOperations", {
			mode: "db",
			jsonlArchive: archive,
			operations: expectedOperations,
		});
		expect(trace.ordinaryOperations).toEqual(expectedOperations);
		const archivePrefix = `${path.resolve(archive)}${path.sep}`;
		const forbidden = trace.accesses.filter(access => {
			const resolved = path.resolve(access.path);
			return resolved === path.resolve(archive) || resolved.startsWith(archivePrefix);
		});
		expect(forbidden).toEqual([]);

		const positiveControl = await driver.invoke<TraceProbe>("traceRepositoryOperations", {
			mode: "db",
			jsonlArchive: archive,
			operations: ["previewImport"],
			importSource: archive,
		});
		expect(
			positiveControl.accesses.some(access => {
				const resolved = path.resolve(access.path);
				return resolved === path.resolve(archive) || resolved.startsWith(archivePrefix);
			}),
		).toBe(true);
	});

	integrationIt("starts and operates JSONL mode with the native library removed and without opening a database", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-jsonl-no-native-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const probe = await driver.invoke<StartupProbe>("startupProbe", {
			mode: "jsonl",
			nativeLibrary: path.join(workspace.path(), "definitely-missing-wcdb.so"),
			jsonlSource: fixture,
			operations: ["listSessions", "getHeader", "append", "flush", "health"],
		});
		expect(probe.ready).toBe(true);
		expect(probe.selectedMode).toBe("jsonl");
		expect(probe.nativeModuleLoaded).toBe(false);
		expect(probe.nativeLoadAttempted).toBe(false);
		expect(probe.databaseOpened).toBe(false);
		expect(probe.jsonlOperationsCompleted).toEqual(["listSessions", "getHeader", "append", "flush", "health"]);
		expect(probe.fallbackUsed).toBe(false);
		expect(probe.health.ready).toBe(true);
	});

	integrationIt("reports DB capability disabled when native loading fails and never falls back to JSONL", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-db-no-native-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const probe = await driver.invoke<StartupProbe>("startupProbe", {
			mode: "db",
			nativeLibrary: path.join(workspace.path(), "definitely-missing-wcdb.so"),
			jsonlSource: fixture,
			operations: ["health", "listSessions"],
		});
		expect(probe.ready).toBe(false);
		expect(probe.selectedMode).toBe("db");
		expect(probe.nativeLoadAttempted).toBe(true);
		expect(probe.databaseOpened).toBe(false);
		expect(probe.jsonlOperationsCompleted).toEqual([]);
		expect(probe.fallbackUsed).toBe(false);
		expect(probe.health).toEqual({ ready: false, capability: "disabled", errorCode: "WCDB_NATIVE_UNAVAILABLE" });
	});
});
