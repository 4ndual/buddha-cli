import { describe, expect, it } from "bun:test";
import {
	createDisabledStorageControlModel,
	runStorageCommand,
	type StorageCommandDependencies,
	type StorageMigrationController,
} from "../../../src/cli/storage";

function quiet(overrides: Partial<StorageCommandDependencies>): Partial<StorageCommandDependencies> {
	return { writeStdout() {}, ...overrides };
}

describe("Turso storage mode fencing", () => {
	it("rejects a missing or stale generation before loading any migration code", async () => {
		const status = createDisabledStorageControlModel();
		status.configurationGeneration = 12;
		status.generationToken = { generation: 12, nonce: "generation-12" };
		let controllerLoads = 0;
		const dependencies = quiet({
			async getStatus() {
				return status;
			},
			async loadMigrationController() {
				controllerLoads += 1;
				throw new Error("must not load for a fenced request");
			},
		});
		const request = { action: "sync" as const, source: "/team/source", destination: "/team/db" };

		expect((await runStorageCommand(request, dependencies)).outcome).toBe("rejected");
		expect(
			(
				await runStorageCommand(
					{
						...request,
						fencePath: "/team/fence.json",
						expectedGeneration: 11,
						expectedNonce: "generation-12",
					},
					dependencies,
				)
			).outcome,
		).toBe("rejected");
		expect(controllerLoads).toBe(0);
	});

	it("allows one current-generation mutation and fences the same process after the generation advances", async () => {
		const status = createDisabledStorageControlModel();
		status.configurationGeneration = 21;
		status.generationToken = { generation: 21, nonce: "generation-21" };
		let executes = 0;
		const controller: StorageMigrationController = {
			async preview() {
				return { message: "preview" };
			},
			async execute() {
				executes += 1;
				return { message: "synchronized" };
			},
		};
		const dependencies = quiet({
			async getStatus() {
				return status;
			},
			async loadMigrationController() {
				return controller;
			},
		});
		const request = {
			action: "sync" as const,
			source: "/team/source",
			destination: "/team/db",
			expectedGeneration: 21,
			fencePath: "/team/fence.json",
			expectedNonce: "generation-21",
		};

		expect((await runStorageCommand(request, dependencies)).outcome).toBe("ok");
		status.configurationGeneration = 22;
		expect((await runStorageCommand(request, dependencies)).outcome).toBe("rejected");
		expect(executes).toBe(1);
	});

	it("keeps JSONL status operational when the native migration driver is unavailable", async () => {
		let nativeLoads = 0;
		const report = await runStorageCommand(
			{ action: "status", machine: true },
			quiet({
				async loadMigrationController() {
					nativeLoads += 1;
					throw new Error("injected native driver unavailability");
				},
			}),
		);

		expect(report.outcome).toBe("ok");
		expect(report.status?.activeMode).toBe("jsonl");
		expect(report.status?.databaseCapability.enabled).toBe(false);
		expect(nativeLoads).toBe(0);
	});

	it("never commits a DB mode change from the preview-only control surface", async () => {
		const status = createDisabledStorageControlModel();
		status.configurationGeneration = 5;
		status.databaseCapability = { enabled: true, verifiedReceipt: "sha256:verified-native-gates" };
		const report = await runStorageCommand(
			{ action: "mode", requestedMode: "db", expectedGeneration: 5 },
			quiet({
				async getStatus() {
					return status;
				},
				async previewModeTransition() {
					return {
						message: "prepared",
						details: { configurationMutated: true, requestedHeadVerified: true },
					};
				},
			}),
		);

		expect(report.outcome).toBe("preview");
		expect(report.status?.activeMode).toBe("jsonl");
		expect(report.details).toMatchObject({ configurationMutated: false, requestedHeadVerified: true });
	});
});
