import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	STORAGE_PANEL_ACTIONS,
	createLogicalExportStorageController,
	shouldLaunchStoragePanel,
} from "../../src/cli/storage/actions";
import { createDisabledStorageControlModel } from "../../src/cli/storage/model";
import { runStorageCommand, type StorageCommandDependencies } from "../../src/cli/storage/storage-cli";
import { StoragePanelComponent } from "../../src/cli/storage/panel";
import { renderStoragePanel } from "../../src/cli/storage/view";
import { LOGICAL_BUNDLE_FORMAT, type LogicalBundle } from "../../src/session/repository/migration/bundle";

const ownedRoot = "/home/andual/Projects/.turso-migration-owned/controls/staging";
const temporaryRoots: string[] = [];

function silentDependencies(overrides: Partial<StorageCommandDependencies> = {}): Partial<StorageCommandDependencies> {
	return { writeStdout() {}, ...overrides };
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	await mkdir(ownedRoot, { recursive: true });
	const root = await mkdtemp(join(ownedRoot, "storage-panel-test-"));
	temporaryRoots.push(root);
	return root;
}

describe("interactive storage panel model and view", () => {
	test("renders backend status and every requested control while cutover stays unavailable", () => {
		const status = createDisabledStorageControlModel();
		status.backends.jsonl = {
			path: "/sentinel/jsonl",
			engine: "OMP JSONL",
			schemaVersion: "3",
			counts: { sessions: 12, origins: 12, branches: 14, versions: 15, events: 120, payloads: 4 },
			sizeBytes: 4096,
			walBytes: 0,
			health: { state: "healthy", message: "verified sentinel" },
		};
		status.backends.database = {
			path: "/sentinel/sessions.turso.db",
			engine: "Turso embedded",
			schemaVersion: "1",
			counts: { sessions: 12, origins: 12, branches: 14, versions: 15, events: 120, payloads: 4 },
			sizeBytes: 8192,
			walBytes: 1024,
			health: { state: "healthy", message: "integrity verified" },
		};

		const rendered = renderStoragePanel(
			status,
			{ stage: "menu", selectedIndex: 0, dryRun: true, input: "" },
			200,
		).join("\n");

		expect(rendered).toContain("default JSONL");
		expect(rendered).toContain("Turso embedded · schema 1");
		expect(rendered).toContain("size 8.0 KiB · WAL 1.0 KiB");
		expect(rendered).toContain("health healthy: integrity verified");
		expect(rendered).toContain("Mode commit/cutover: UNAVAILABLE");
		for (const label of [
			"Create database",
			"Open database",
			"Copy as-is",
			"Normalize copy",
			"Import JSONL → DB",
			"Export DB → JSONL",
			"Synchronize both",
			"Migrate",
			"Adopt staged database",
			"Verify",
			"Repair",
			"Backup",
			"Rollback",
			"Recover export receipt",
			"Preview mode switch",
		]) {
			expect(rendered).toContain(label);
		}
		const compact = renderStoragePanel(
			status,
			{ stage: "menu", selectedIndex: STORAGE_PANEL_ACTIONS.length - 1, dryRun: true, input: "" },
			120,
			24,
		);
		expect(compact).toHaveLength(24);
		expect(compact.join("\n")).toContain("> Preview mode switch");
	});

	test("action metadata enforces explicit paths, backup gates, and preview-only cutover", () => {
		const copy = STORAGE_PANEL_ACTIONS.find(action => action.id === "copy");
		const repair = STORAGE_PANEL_ACTIONS.find(action => action.id === "repair");
		const rollback = STORAGE_PANEL_ACTIONS.find(action => action.id === "rollback");
		const recover = STORAGE_PANEL_ACTIONS.find(action => action.id === "recover");
		const mode = STORAGE_PANEL_ACTIONS.find(action => action.id === "mode");
		const adopt = STORAGE_PANEL_ACTIONS.find(action => action.id === "adopt");
		expect(copy?.requiresSource).toBe(true);
		expect(copy?.requiresDestination).toBe(true);
		expect(repair?.requiresFreshBackup).toBe(true);
		expect(rollback?.requiresFreshBackup).toBe(true);
		expect(recover?.requiresFreshBackup).toBe(true);
		expect(mode?.previewOnly).toBe(true);
		expect(adopt?.previewOnly).toBe(true);
	});

	test("command convention opens the panel only for an explicit panel request or bare interactive command", () => {
		expect(shouldLaunchStoragePanel(undefined, false, false, true, true)).toBe(true);
		expect(shouldLaunchStoragePanel("status", true, false, true, true)).toBe(true);
		expect(shouldLaunchStoragePanel("status", false, false, true, true)).toBe(false);
		expect(shouldLaunchStoragePanel(undefined, false, true, true, true)).toBe(false);
		expect(shouldLaunchStoragePanel(undefined, false, false, false, true)).toBe(false);
	});

	test("interactive action requires paths, dry-run, fresh backup, and second confirmation before recovery", async () => {
		const status = createDisabledStorageControlModel();
		let previews = 0;
		let executions = 0;
		let executedRequest: { pathsConfirmed?: boolean; secondConfirmation?: boolean; backupReceipt?: string } | undefined;
		const component = new StoragePanelComponent(
			{ rows: 80, requestRender() {} },
			status,
			{
				source: "/sentinel/published",
				destination: "/sentinel/export.job.json",
				allowedRoot: "/sentinel",
				commandDependencies: silentDependencies({
					async getStatus() {
						return status;
					},
					async loadMigrationController() {
						return {
							async preview() {
								previews += 1;
								return {
									message: "dry-run verified sentinel recovery",
									details: { backupReceipt: "sha256:fresh-sentinel" },
								};
							},
							async execute(request) {
								executions += 1;
								executedRequest = request;
								return { message: "recovered sentinel receipt" };
							},
						};
					},
				}),
			},
		);
		component.handleInput("d");
		const recoverIndex = STORAGE_PANEL_ACTIONS.findIndex(action => action.id === "recover");
		for (let index = 0; index < recoverIndex; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\r");
		expect(component.state.stage).toBe("source");
		component.handleInput("\r");
		expect(component.state.stage).toBe("destination");
		component.handleInput("\r");
		expect(component.state.stage).toBe("confirm-paths");
		for (const character of "CONFIRM PATHS") component.handleInput(character);
		component.handleInput("\r");
		await component.waitForIdle();
		expect(component.state.stage).toBe("backup-receipt");
		expect(component.state.preview?.message).toBe("dry-run verified sentinel recovery");
		for (const character of "sha256:fresh-sentinel") component.handleInput(character);
		component.handleInput("\r");
		expect(component.state.stage).toBe("second-confirmation");
		for (const character of "APPLY") component.handleInput(character);
		component.handleInput("\r");
		await component.waitForIdle();

		expect(component.state.stage).toBe("result");
		expect(component.state.result?.message).toBe("recovered sentinel receipt");
		expect(previews).toBe(2);
		expect(executions).toBe(1);
		expect(executedRequest).toMatchObject({
			pathsConfirmed: true,
			secondConfirmation: true,
			backupReceipt: "sha256:fresh-sentinel",
		});
	});
});

describe("storage panel transfer actions", () => {
	test("logical export adapter previews and durably publishes through the export API", async () => {
		const root = await temporaryRoot();
		const destination = join(root, "published");
		const journalPath = join(root, "export.job.json");
		const bundle: LogicalBundle = {
			format: LOGICAL_BUNDLE_FORMAT,
			replica_id: "storage-panel-export-sentinel",
			origins: [],
			events: [],
			versions: [],
			branches: [],
		};
		let snapshots = 0;
		const controller = createLogicalExportStorageController({
			async readLogicalSnapshot() {
				snapshots += 1;
				return bundle;
			},
		});
		const dependencies = silentDependencies({
			async loadMigrationController() {
				return controller;
			},
		});
		const base = {
			action: "export" as const,
			source: "sentinel-repository",
			destination,
			allowedRoot: root,
			journalPath,
			generationId: "storage-panel-proof",
			jobId: "storage-panel-export",
		};

		const preview = await runStorageCommand({ ...base, dryRun: true }, dependencies);
		expect(preview.outcome).toBe("preview");
		expect(preview.counts).toEqual({ origins: 0, branches: 0, versions: 0, events: 0 });
		expect(await Bun.file(journalPath).exists()).toBe(false);

		const published = await runStorageCommand(
			{ ...base, pathsConfirmed: true, secondConfirmation: true },
			dependencies,
		);
		expect(published.outcome).toBe("ok");
		expect(published.details?.manifestSha256).toBeString();
		expect(published.details?.dryRunSummary).toBe("Verified logical export preview");
		expect(await Bun.file(join(destination, "manifest.json")).exists()).toBe(true);
		expect(snapshots).toBe(3);
	});

	test("adoption remains preview-only even when an execution adapter is installed", async () => {
		let executes = 0;
		const report = await runStorageCommand(
			{
				action: "adopt",
				source: "/sentinel/staged.db",
				destination: "/sentinel/profile",
				pathsConfirmed: true,
				secondConfirmation: true,
				backupReceipt: "sha256:fresh-backup",
			},
			silentDependencies({
				async loadMigrationController() {
					return {
						async preview() {
							return {
								message: "adoption candidate verified",
								details: { backupReceipt: "sha256:fresh-backup" },
							};
						},
						async execute() {
							executes += 1;
							return { message: "must not execute" };
						},
					};
				},
			}),
		);

		expect(report.outcome).toBe("preview");
		expect(report.message).toBe("adoption candidate verified");
		expect(report.details).toMatchObject({ configurationMutated: false, executionEnabled: false });
		expect(executes).toBe(0);
	});

	test("preflight failures remain verbatim and prevent execution", async () => {
		let executes = 0;
		const failure = "preflight failed: WAL checksum mismatch at sentinel page 7";
		const report = await runStorageCommand(
			{
				action: "repair",
				source: "/sentinel/source",
				destination: "/sentinel/copy",
				pathsConfirmed: true,
				secondConfirmation: true,
				backupReceipt: "sha256:sentinel-backup",
			},
			silentDependencies({
				async loadMigrationController() {
					return {
						async preview() {
							throw new Error(failure);
						},
						async execute() {
							executes += 1;
							return { message: "must not execute" };
						},
					};
				},
			}),
		);

		expect(report.outcome).toBe("failed");
		expect(report.message).toBe(failure);
		expect(executes).toBe(0);
	});
});
