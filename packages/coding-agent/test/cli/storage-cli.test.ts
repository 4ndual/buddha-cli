import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	createDisabledStorageControlModel,
	defaultStorageCommandDependencies,
	formatStorageReportJson,
	runStorageCommand,
	type StorageCommandDependencies,
	type StorageMigrationController,
	type StorageReport,
} from "../../src/cli/storage";
import {
	LOGICAL_BUNDLE_FORMAT,
	canonicalJson,
	publishLogicalBundle,
	sha256,
	type LogicalBundle,
} from "../../src/session/repository/migration/bundle";
import {
	createGenerationFence,
	readFenceState,
} from "../../src/session/repository/migration/fencing";
import { createMigrationJob } from "../../src/session/repository/migration/jobs";

function silentDependencies(overrides: Partial<StorageCommandDependencies> = {}): Partial<StorageCommandDependencies> {
	return { writeStdout() {}, ...overrides };
}
const ownedRoot = "/home/andual/Projects/.turso-migration-owned/controls/staging";
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	await mkdir(ownedRoot, { recursive: true });
	const root = await mkdtemp(join(ownedRoot, "storage-cli-test-"));
	temporaryRoots.push(root);
	return root;
}


describe("storage control surface", () => {
	test("JSONL status works without loading a database or migration driver", async () => {
		let driverLoads = 0;
		const report = await runStorageCommand(
			{ action: "status", machine: true },
			silentDependencies({
				async loadMigrationController() {
					driverLoads += 1;
					throw new Error("native driver unavailable");
				},
			}),
		);

		expect(report.outcome).toBe("ok");
		expect(report.status?.activeMode).toBe("jsonl");
		expect(report.status?.databaseCapability.failure?.code).toBe("capability-not-verified");
		expect(report.status?.recoveryActions.map(action => action.id)).toEqual(["verify-jsonl", "recover-jsonl"]);
		expect(driverLoads).toBe(0);
	});

	test("dry-run previews an explicit migration without executing writes", async () => {
		let previews = 0;
		let writes = 0;
		const controller: StorageMigrationController = {
			async preview() {
				previews += 1;
				return { message: "inventory preview", counts: { discovered: 2 } };
			},
			async execute() {
				writes += 1;
				return { message: "wrote inventory" };
			},
		};
		const report = await runStorageCommand(
			{ action: "inventory", source: "/copied/fixtures", dryRun: true },
			silentDependencies({ async loadMigrationController() {
				return controller;
			} }),
		);

		expect(report.outcome).toBe("preview");
		expect(report.counts).toEqual({ discovered: 2 });
		expect(previews).toBe(1);
		expect(writes).toBe(0);
	});

	test("Database mode stays rejected until a verified capability receipt exists", async () => {
		let transitionPreviews = 0;
		const rejected = await runStorageCommand(
			{ action: "mode", requestedMode: "db" },
			silentDependencies({
				async previewModeTransition() {
					transitionPreviews += 1;
					return { message: "should not run" };
				},
			}),
		);
		expect(rejected.outcome).toBe("rejected");
		expect(transitionPreviews).toBe(0);

		const capable = createDisabledStorageControlModel();
		capable.databaseCapability = { enabled: true, verifiedReceipt: "sha256:capability-receipt" };
		const preview = await runStorageCommand(
			{ action: "mode", requestedMode: "db" },
			silentDependencies({
				async getStatus() {
					return capable;
				},
				async previewModeTransition() {
					transitionPreviews += 1;
					return { message: "prepared", details: { configurationMutated: true } };
				},
			}),
		);
		expect(preview.outcome).toBe("preview");
		expect(preview.details?.configurationMutated).toBe(false);
		expect(preview.status?.activeMode).toBe("jsonl");
		expect(transitionPreviews).toBe(1);
	});
	test("real mode preparation persists a verified fence without committing active mode", async () => {
		const root = await temporaryRoot();
		const fencePath = join(root, "storage.fence.json");
		const token = await createGenerationFence(fencePath, "jsonl");
		const statusReport = await runStorageCommand(
			{ action: "status", fencePath },
			silentDependencies(),
		);
		expect(statusReport.status?.generationToken).toEqual(token);

		const steps: string[] = [];
		const report = await runStorageCommand(
			{
				action: "mode",
				requestedMode: "db",
				fencePath,
				expectedGeneration: token.generation,
				expectedNonce: token.nonce,
			},
			silentDependencies({
				async getStatus(request) {
					const status = await defaultStorageCommandDependencies.getStatus(request);
					status.databaseCapability = {
						enabled: true,
						verifiedReceipt: "sha256:capability-receipt",
					};
					return status;
				},
				async loadTransitionSteps() {
					return {
						async prepare() {
							steps.push("prepare");
						},
						async drain() {
							steps.push("drain");
						},
						async synchronize() {
							steps.push("synchronize");
						},
						async verify() {
							steps.push("verify");
							return "sha256:transfer-receipt";
						},
					};
				},
			}),
		);

		expect(report.outcome).toBe("preview");
		expect(report.details?.configurationMutated).toBe(false);
		expect(steps).toEqual(["prepare", "drain", "synchronize", "verify"]);
		expect(report.status?.activeMode).toBe("jsonl");
		expect(report.status?.configurationGeneration).toBe(token.generation + 1);
		expect(report.status?.preparedTransition?.state).toBe("verified");
		const fence = await readFenceState(fencePath);
		expect(fence.state).toBe("verified");
		expect(fence.active_mode).toBe("jsonl");
		expect(fence.target_mode).toBe("db");
	});


	test("only explicit migration actions can obtain the JSONL-access controller", async () => {
		let migrationLoads = 0;
		const deps = silentDependencies({
			async loadMigrationController() {
				migrationLoads += 1;
				return {
					async preview() {
						return { message: "verified" };
					},
					async execute() {
						return { message: "verified" };
					},
				};
			},
		});

		await runStorageCommand({ action: "status" }, deps);
		await runStorageCommand({ action: "mode", requestedMode: "jsonl" }, deps);
		expect(migrationLoads).toBe(0);
		await runStorageCommand(
			{ action: "verify", source: "/copied/jsonl", destination: "/copied/report", dryRun: true },
			deps,
		);
		expect(migrationLoads).toBe(1);
	});

	test("repository mutations require and compare the persisted fencing generation", async () => {
		let executes = 0;
		const status = createDisabledStorageControlModel();
		status.configurationGeneration = 7;
		status.generationToken = { generation: 7, nonce: "nonce-7" };
		const controller: StorageMigrationController = {
			async preview() {
				return { message: "preview" };
			},
			async execute() {
				executes += 1;
				return { message: "imported" };
			},
		};
		const deps = silentDependencies({
			async getStatus() {
				return status;
			},
			async loadMigrationController() {
				return controller;
			},
		});
		const request = { action: "import" as const, source: "/stage", destination: "/db" };

		expect((await runStorageCommand(request, deps)).outcome).toBe("rejected");
		expect(
			(
				await runStorageCommand(
					{ ...request, fencePath: "/copied/fence", expectedGeneration: 6, expectedNonce: "nonce-7" },
					deps,
				)
			).outcome,
		).toBe("rejected");
		expect(
			(
				await runStorageCommand(
					{ ...request, fencePath: "/copied/fence", expectedGeneration: 7, expectedNonce: "nonce-7" },
					deps,
				)
			).outcome,
		).toBe("ok");
		expect(executes).toBe(1);
	});

	test("recover records a verified published export and is idempotent", async () => {
		const root = await temporaryRoot();
		const publishedPath = join(root, "published");
		const journalPath = join(root, "export.job.json");
		const dryRunJournal = join(root, "dry-run.job.json");
		const dryRun = await runStorageCommand(
			{
				action: "recover",
				source: join(root, "missing-publication"),
				destination: dryRunJournal,
				allowedRoot: root,
				dryRun: true,
			},
			silentDependencies(),
		);
		expect(dryRun.outcome).toBe("preview");
		expect(await Bun.file(dryRunJournal).exists()).toBe(false);
		const bundle: LogicalBundle = {
			format: LOGICAL_BUNDLE_FORMAT,
			replica_id: "controls-recovery-fixture",
			origins: [],
			events: [],
			versions: [],
			branches: [],
		};
		const encoded = canonicalJson(bundle);
		const bundleHash = sha256(encoded);
		await publishLogicalBundle(bundle, {
			allowedRoot: root,
			destination: publishedPath,
			generationId: "controls-proof",
		});
		await createMigrationJob(journalPath, {
			jobId: "controls-recovery",
			kind: "export",
			maxBatchBytes: 1024,
			items: [{ key: bundleHash, bytes: encoded.length, checksum: bundleHash }],
		});
		const request = {
			action: "recover" as const,
			source: publishedPath,
			destination: journalPath,
			allowedRoot: root,
		};

		const recovered = await runStorageCommand(request, silentDependencies());
		expect(recovered.outcome).toBe("ok");
		expect(recovered.details?.recoveryStatus).toBe("receipt-recovered");
		const repeated = await runStorageCommand(request, silentDependencies());
		expect(repeated.outcome).toBe("ok");
		expect(repeated.details?.recoveryStatus).toBe("already-recorded");
	});

	test("machine reports have a stable schema and key order", () => {
		const report: StorageReport = {
			schema: "omp.storage.report.v1",
			action: "sync",
			outcome: "preview",
			dryRun: true,
			allBranches: true,
			resume: false,
			cancelAfterCurrentBatch: false,
			message: "preview",
			counts: { quarantined: 0, imported: 3 },
		};
		const encoded = formatStorageReportJson(report);
		expect(encoded).toBe(
			'{"action":"sync","allBranches":true,"cancelAfterCurrentBatch":false,"counts":{"imported":3,"quarantined":0},"dryRun":true,"message":"preview","outcome":"preview","resume":false,"schema":"omp.storage.report.v1"}\n',
		);
		expect(formatStorageReportJson(report)).toBe(encoded);
	});
});
