import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { hasWcdbTestAdapter, type JsonValue, WcdbMigrationTestDriver } from "./migration-test-driver";

interface RecoveryState extends Record<string, JsonValue> {
	committedNativeEntryIds: string[];
	branchHeadHashes: string[];
	receiptIds: string[];
	publishedGenerations: string[];
	selectedMode: string;
	configurationGeneration: number;
	indexComplete: boolean;
	indexWatermark: string | null;
	checkpointValid: boolean;
	contextHash: string;
}

interface FtsProbe extends Record<string, JsonValue> {
	beforeRebuildComplete: boolean;
	afterRebuildComplete: boolean;
	queries: Record<string, string[]>;
	duplicateHits: string[];
}

interface BackupProbe extends Record<string, JsonValue> {
	verified: boolean;
	branchHeadsExpected: string[];
	branchHeadsRestored: string[];
	payloadHashesExpected: string[];
	payloadHashesRestored: string[];
}

interface ErrorProbe extends Record<string, JsonValue> {
	code: string;
	published: boolean;
	committed: boolean;
	originalIntact: boolean;
}

interface CorruptionProbe extends Record<string, JsonValue> {
	integrityOk: boolean;
	failedClosed: boolean;
	repairUsedCopy: boolean;
	originalHashBefore: string;
	originalHashAfter: string;
	salvageReportPath: string;
}

interface UpgradeProbe extends Record<string, JsonValue> {
	incompatibleRefused: boolean;
	rollbackVerified: boolean;
	previousSchemaReadable: boolean;
	jsonlRecoveryAvailable: boolean;
}

interface NativeCrashProbe extends Record<string, JsonValue> {
	workerCrashed: boolean;
	reopened: boolean;
	acknowledgedCommitPresent: boolean;
	duplicateEvents: number;
}

interface AccountingProbe extends Record<string, JsonValue> {
	discovered: number;
	accounted: number;
	imported: number;
	excluded: number;
	quarantined: number;
	unmappedHashes: string[];
	duplicateHashes: string[];
}

interface RecoveryDrill extends Record<string, JsonValue> {
	exportVerified: boolean;
	continuedInJsonl: boolean;
	reimportStatus: "committed" | "sibling-fork";
	forkPointVerified: boolean;
	originalBranchPreserved: boolean;
}

const fixture = path.resolve(import.meta.dir, "../../fixtures/wcdb/omp-v3-complete.jsonl");
const integrationIt = it.skipIf(!hasWcdbTestAdapter);
const inventoryLedger = process.env.OMP_WCDB_INVENTORY_LEDGER;
const accountingIt = it.skipIf(!hasWcdbTestAdapter || !inventoryLedger);

async function seed(driver: WcdbMigrationTestDriver): Promise<void> {
	await driver.invoke("reset", {});
	await driver.invoke("importArchive", {
		source: fixture,
		sourceNamespace: "omp-v3",
		replicaId: "fault-source",
	});
}

async function expectCrash(
	driver: WcdbMigrationTestDriver,
	operation: string,
	input: Record<string, JsonValue>,
	expectedPoint: string,
): Promise<void> {
	const fault = input.fault;
	if (typeof fault !== "object" || fault === null || Array.isArray(fault)) {
		throw new Error(`Fault input for ${operation} must be an object`);
	}
	const injectionId = crypto.randomUUID();
	const crashed = await driver.invokeRaw(operation, {
		...input,
		fault: { ...fault, injectionId },
	});
	expect(crashed.exitCode).not.toBe(0);
	const markerPrefix = "OMP_WCDB_FAULT_REACHED ";
	const markerLine = crashed.stderr
		.split("\n")
		.find(line => line.startsWith(markerPrefix));
	if (!markerLine) {
		throw new Error(`Adapter exited without reaching ${operation}:${expectedPoint}: ${crashed.stderr}`);
	}
	const marker = JSON.parse(markerLine.slice(markerPrefix.length)) as {
		protocol: string;
		operation: string;
		point: string;
		injectionId: string;
		receiptHash: string;
	};
	expect(marker).toEqual({
		protocol: "omp-wcdb-fault-marker-v1",
		operation,
		point: expectedPoint,
		injectionId,
		receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
}

describe("WCDB fault injection and recovery", () => {
	integrationIt("leaves killed normalization output unpublished", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-normalize-kill-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await expectCrash(
			driver,
			"normalizeArchive",
			{
				source: fixture,
				destination: path.join(workspace.path(), "normalized-generation"),
				fault: { point: "before-publication", effect: "process-exit" },
			},
			"before-publication",
		);
		const state = await driver.invoke<{ published: boolean; completionMarker: boolean } & Record<string, JsonValue>>(
			"inspectNormalization",
			{},
		);
		expect(state).toEqual({ published: false, completionMarker: false });
	});

	integrationIt("rolls back a process death before transaction commit", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-transaction-kill-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		await expectCrash(
			driver,
			"append",
			{
				expectedHead: "current",
				event: { nativeEntryId: "uncommitted", semanticPayload: { text: "must roll back" } },
				fault: { point: "before-commit", effect: "process-exit" },
			},
			"before-commit",
		);
		const state = await driver.invoke<RecoveryState>("reopenAndInspect", {});
		expect(state.committedNativeEntryIds).not.toContain("uncommitted");
	});

	integrationIt("recovers a commit acknowledged by durability but interrupted before the caller receipt exactly once", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-ack-recovery-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		await expectCrash(
			driver,
			"append",
			{
				expectedHead: "current",
				event: { nativeEntryId: "committed-before-reply", semanticPayload: { text: "durable" } },
				fault: { point: "after-commit-before-reply", effect: "process-exit" },
			},
			"after-commit-before-reply",
		);
		const recovered = await driver.invoke<RecoveryState>("recoverAcknowledgedCommit", {
			nativeEntryId: "committed-before-reply",
		});
		expect(recovered.committedNativeEntryIds.filter(id => id === "committed-before-reply")).toHaveLength(1);
		expect(recovered.receiptIds).toContain("committed-before-reply");
		const repeated = await driver.invoke<RecoveryState>("recoverAcknowledgedCommit", {
			nativeEntryId: "committed-before-reply",
		});
		expect(repeated.committedNativeEntryIds.filter(id => id === "committed-before-reply")).toHaveLength(1);
	});

	integrationIt("repairs publication receipt after export dies without publishing a partial generation", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-export-kill-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		await expectCrash(
			driver,
			"exportArchive",
			{
				destination: path.join(workspace.path(), "export"),
				allBranches: true,
				fault: { point: "after-publication-before-receipt", effect: "process-exit" },
			},
			"after-publication-before-receipt",
		);
		const repaired = await driver.invoke<{ manifestVerified: boolean; receiptRecorded: boolean; generations: string[] } & Record<string, JsonValue>>(
			"repairExportPublication",
			{},
		);
		expect(repaired.manifestVerified).toBe(true);
		expect(repaired.receiptRecorded).toBe(true);
		expect(repaired.generations).toHaveLength(1);
		const repeated = await driver.invoke<{ generations: string[] } & Record<string, JsonValue>>(
			"repairExportPublication",
			{},
		);
		expect(repeated.generations).toHaveLength(1);
	});

	integrationIt("keeps the prior mode and fencing generation when mode activation dies", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-mode-kill-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await driver.invoke("reset", { selectedMode: "jsonl", configurationGeneration: 7 });
		await expectCrash(
			driver,
			"activateMode",
			{
				targetMode: "db",
				expectedGeneration: 7,
				fault: { point: "before-config-commit", effect: "process-exit" },
			},
			"before-config-commit",
		);
		const state = await driver.invoke<RecoveryState>("reopenAndInspect", {});
		expect(state.selectedMode).toBe("jsonl");
		expect(state.configurationGeneration).toBe(7);
	});

	integrationIt("exposes an interrupted FTS watermark and rebuilds code, path, Unicode, Spanish, exact-phrase, and prefix results without duplicates", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-fts-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		await expectCrash(
			driver,
			"rebuildFts",
			{ fault: { point: "mid-index-batch", effect: "process-exit" } },
			"mid-index-batch",
		);
		const probe = await driver.invoke<FtsProbe>("reopenAndRebuildFts", {
			queries: {
				codeIdentifier: "const mañana",
				path: "src/mañana.ts",
				unicode: "mañana",
				spanish: "Busca",
				phrase: "\"Running lookup\"",
				prefix: "look*",
			},
		});
		expect(probe.beforeRebuildComplete).toBe(false);
		expect(probe.afterRebuildComplete).toBe(true);
		expect(probe.queries.codeIdentifier).toContain("t1");
		expect(probe.queries.path).toContain("u1");
		expect(probe.queries.unicode).toContain("u1");
		expect(probe.queries.spanish).toContain("u1");
		expect(probe.queries.phrase).toContain("a1");
		expect(probe.queries.prefix).toContain("a1");
		expect(probe.duplicateHits).toEqual([]);
	});

	integrationIt("ignores a killed checkpoint and replays ancestry to the same context hash", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-checkpoint-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		const baseline = await driver.invoke<RecoveryState>("reopenAndInspect", {});
		await expectCrash(
			driver,
			"writeContextCheckpoint",
			{
				branch: "current",
				fault: { point: "mid-checkpoint", effect: "process-exit" },
			},
			"mid-checkpoint",
		);
		const recovered = await driver.invoke<RecoveryState>("restoreContext", { branch: "current" });
		expect(recovered.checkpointValid).toBe(false);
		expect(recovered.contextHash).toBe(baseline.contextHash);
	});

	for (const fault of [
		{ name: "disk full", effect: "disk-full", expectedCode: "ENOSPC" },
		{ name: "short write", effect: "short-write", expectedCode: "SHORT_WRITE" },
	] as const) {
		integrationIt(`rejects ${fault.name} without committing or publishing partial state`, async () => {
			using workspace = TempDir.createSync("@omp-wcdb-io-fault-");
			const driver = new WcdbMigrationTestDriver(workspace.path());
			await seed(driver);
			const probe = await driver.invoke<ErrorProbe>("ioFaultProbe", {
				operation: "append-and-export",
				fault: { point: "write", effect: fault.effect },
			});
			expect(probe.code).toBe(fault.expectedCode);
			expect(probe.committed).toBe(false);
			expect(probe.published).toBe(false);
			expect(probe.originalIntact).toBe(true);
		});
	}

	integrationIt("surfaces bounded busy-lock failure without losing the acknowledged head", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-busy-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		const before = await driver.invoke<RecoveryState>("reopenAndInspect", {});
		const probe = await driver.invoke<{ code: string; elapsedMs: number; configuredTimeoutMs: number } & Record<string, JsonValue>>(
			"busyLockProbe",
			{ configuredTimeoutMs: 75 },
		);
		expect(probe.code).toBe("BUSY_TIMEOUT");
		expect(probe.elapsedMs).toBeGreaterThanOrEqual(probe.configuredTimeoutMs);
		expect(probe.elapsedMs).toBeLessThan(probe.configuredTimeoutMs + 500);
		expect((await driver.invoke<RecoveryState>("reopenAndInspect", {})).branchHeadHashes).toEqual(before.branchHeadHashes);
	});

	integrationIt("fails closed on corrupt DB or WAL and performs salvage only on a copy", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-corrupt-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		for (const target of ["database", "wal"] as const) {
			const probe = await driver.invoke<CorruptionProbe>("corruptAndRecover", { target });
			expect(probe.integrityOk).toBe(false);
			expect(probe.failedClosed).toBe(true);
			expect(probe.repairUsedCopy).toBe(true);
			expect(probe.originalHashAfter).toBe(probe.originalHashBefore);
			expect(await Bun.file(probe.salvageReportPath).exists()).toBe(true);
		}
	});

	integrationIt("refuses an interrupted incompatible schema upgrade while retaining rollback and JSONL recovery", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-upgrade-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		const probe = await driver.invoke<UpgradeProbe>("interruptedUpgradeProbe", {
			fault: { point: "after-schema-write-before-activation", effect: "process-exit" },
		});
		expect(probe).toEqual({
			incompatibleRefused: true,
			rollbackVerified: true,
			previousSchemaReadable: true,
			jsonlRecoveryAvailable: true,
		});
	});

	integrationIt("creates a verified backup with identical branch heads and payload hashes", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-backup-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		const probe = await driver.invoke<BackupProbe>("backupAndRestore", {
			destination: path.join(workspace.path(), "backup"),
		});
		expect(probe.verified).toBe(true);
		expect(probe.branchHeadsRestored.sort()).toEqual(probe.branchHeadsExpected.sort());
		expect(probe.payloadHashesRestored.sort()).toEqual(probe.payloadHashesExpected.sort());
	});

	integrationIt("reopens after native worker crash without losing or duplicating acknowledged commits", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-native-crash-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		const probe = await driver.invoke<NativeCrashProbe>("nativeCrashReopenProbe", {});
		expect(probe.workerCrashed).toBe(true);
		expect(probe.reopened).toBe(true);
		expect(probe.acknowledgedCommitPresent).toBe(true);
		expect(probe.duplicateEvents).toBe(0);
	});

	accountingIt("accounts every inventoried source hash with an evidence-backed disposition", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-accounting-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const probe = await driver.invoke<AccountingProbe>("accountingAudit", {
			inventoryLedger: inventoryLedger ?? "",
		});
		expect(probe.accounted).toBe(probe.discovered);
		expect(probe.imported + probe.excluded + probe.quarantined).toBe(probe.discovered);
		expect(probe.unmappedHashes).toEqual([]);
		expect(probe.duplicateHashes).toEqual([]);
	});

	integrationIt("exports a branch, continues it in JSONL, and reimports the continuation as the correct extension or sibling", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-recovery-drill-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await seed(driver);
		const probe = await driver.invoke<RecoveryDrill>("exportContinueReimportDrill", {
			destination: path.join(workspace.path(), "rollback-export"),
			continuation: { nativeEntryId: "continued-after-export", text: "continued safely" },
		});
		expect(probe.exportVerified).toBe(true);
		expect(probe.continuedInJsonl).toBe(true);
		expect(["committed", "sibling-fork"]).toContain(probe.reimportStatus);
		expect(probe.forkPointVerified).toBe(true);
		expect(probe.originalBranchPreserved).toBe(true);
	});
});
