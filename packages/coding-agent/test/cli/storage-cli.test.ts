import { describe, expect, test } from "bun:test";
import {
	createDisabledStorageControlModel,
	formatStorageReportJson,
	runStorageCommand,
	type StorageCommandDependencies,
	type StorageMigrationController,
	type StorageReport,
} from "../../src/cli/storage";

function silentDependencies(overrides: Partial<StorageCommandDependencies> = {}): Partial<StorageCommandDependencies> {
	return { writeStdout() {}, ...overrides };
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
		expect((await runStorageCommand({ ...request, expectedGeneration: 6 }, deps)).outcome).toBe("rejected");
		expect((await runStorageCommand({ ...request, expectedGeneration: 7 }, deps)).outcome).toBe("ok");
		expect(executes).toBe(1);
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
