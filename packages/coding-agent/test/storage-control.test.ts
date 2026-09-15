import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../src/modes/theme/theme";
import { parseStorageCommand, runStorageCommand } from "../src/storage/control/cli";
import { modeActivationBlocker } from "../src/storage/control/service";
import { StoragePanelComponent } from "../src/storage/control/storage-panel";
import { StoragePanelController } from "../src/storage/control/storage-panel-controller";
import type {
	StorageControlRequest,
	StorageControlResult,
	StorageControlService,
	StorageControlStatus,
	StorageReportSink,
} from "../src/storage/control/types";

beforeAll(() => {
	initTheme();
});

function createStatus(overrides: Partial<StorageControlStatus> = {}): StorageControlStatus {
	return {
		mode: "jsonl",
		activeBackend: "OMP JSONL session repository",
		capabilities: {
			jsonl: { available: true, label: "JSONL available" },
			database: { available: true, label: "WCDB available" },
		},
		activation: { native: true, verifiedTransfer: true, rollbackExport: true },
		lastVerifiedTransfer: {
			completedAt: "2026-09-15T10:00:00.000Z",
			direction: "jsonl-to-db",
			reportId: "transfer-7",
		},
		pathExtensions: [
			{
				extensionId: "legacy-path-reader",
				detail: "Requires a session JSONL filesystem path.",
				choices: [
					{ kind: "export", label: "export this branch to JSONL" },
					{ kind: "jsonl", label: "keep JSONL mode" },
				],
			},
		],
		freshnessNotice: "No fallback or dual write; inactive copies may be stale.",
		...overrides,
	};
}

function createPreviewResult(status: StorageControlStatus): StorageControlResult {
	return {
		outcome: "preview",
		message: "Preview complete; no content was merged.",
		status,
		preview: {
			jobId: "preview-1",
			direction: "synchronize",
			dryRun: true,
			counts: {
				newOrigins: 2,
				newVersions: 3,
				extensions: 5,
				siblingForks: 7,
				duplicates: 11,
				quarantined: 13,
			},
			inputBytes: 1024,
			requiredBytes: 2048,
			warnings: ["one item needs a workspace mapping"],
		},
	};
}

class FakeStorageControlService implements StorageControlService {
	readonly calls: string[] = [];
	status: StorageControlStatus;
	previewResult: StorageControlResult;

	constructor(status: StorageControlStatus) {
		this.status = status;
		this.previewResult = createPreviewResult(status);
	}

	async getStatus(): Promise<StorageControlStatus> {
		this.calls.push("status");
		return this.status;
	}

	async preview(request: StorageControlRequest): Promise<StorageControlResult> {
		this.calls.push(`preview:${request.action}:${request.dryRun}`);
		return this.previewResult;
	}

	async execute(request: StorageControlRequest): Promise<StorageControlResult> {
		this.calls.push(`execute:${request.action}:${request.dryRun}:${request.jobId ?? "-"}`);
		return { outcome: "completed", message: "completed", status: this.status };
	}

	async cancelAfterCurrentBatch(jobId: string): Promise<StorageControlResult> {
		this.calls.push(`cancel:${jobId}`);
		return { outcome: "cancel-requested", message: "cancel requested", status: this.status };
	}

	async resume(jobId: string): Promise<StorageControlResult> {
		this.calls.push(`resume:${jobId}`);
		return { outcome: "resumed", message: "resumed", status: this.status };
	}
}

describe("storage command parsing", () => {
	it("requires explicit import endpoints and preserves dry-run branch/report inputs", () => {
		expect(() => parseStorageCommand({ action: "import", source: "/archive" })).toThrow("--destination");
		expect(
			parseStorageCommand({
				action: "import",
				source: "/archive",
				destination: "/staging/sessions.wcdb.sqlite",
				dryRun: true,
				allBranches: true,
				jobId: "job-9",
				reportPath: "/reports/import.jsonl",
				format: "jsonl",
			}),
		).toEqual({
			action: "import",
			source: "/archive",
			destination: "/staging/sessions.wcdb.sqlite",
			dryRun: true,
			allBranches: true,
			jobId: "job-9",
			reportPath: "/reports/import.jsonl",
			format: "jsonl",
			targetMode: undefined,
		});
	});

	it("accepts only explicit jsonl/db mode targets", () => {
		expect(parseStorageCommand({ action: "mode", mode: "db" }).targetMode).toBe("db");
		expect(() => parseStorageCommand({ action: "mode", mode: "automatic" })).toThrow("jsonl or db");
		expect(() => parseStorageCommand({ action: "sync", mode: "jsonl" })).toThrow("mode argument");
	});

	it("routes dry-run execution only through preview and emits the same machine report to stdout and --report", async () => {
		const service = new FakeStorageControlService(createStatus());
		const written: string[] = [];
		const stdout: string[] = [];
		const sink: StorageReportSink = {
			writeStdout(serialized): void {
				stdout.push(serialized);
			},
			async writeReport(path, serialized): Promise<void> {
				written.push(`${path}\n${serialized}`);
			},
		};
		const request = parseStorageCommand({
			action: "sync",
			source: "/jsonl",
			destination: "/db",
			dryRun: true,
			reportPath: "/reports/sync.json",
		});
		const report = await runStorageCommand(request, service, sink, () => new Date("2026-09-15T11:00:00.000Z"));
		expect(service.calls).toEqual(["preview:sync:true"]);
		expect(report.result.preview?.counts).toEqual({
			newOrigins: 2,
			newVersions: 3,
			extensions: 5,
			siblingForks: 7,
			duplicates: 11,
			quarantined: 13,
		});
		expect(JSON.parse(stdout[0]).schemaVersion).toBe("omp.storage.control.v1");
		expect(written[0].slice(written[0].indexOf("\n") + 1)).toBe(stdout[0]);
	});
});

describe("storage activation and terminal controller", () => {
	it("blocks Database activation before native or verification gates and never invokes mutation", async () => {
		const blocker = {
			code: "native-load-failed",
			message: "libOMPWCDB.so could not be loaded for the pinned Bun ABI.",
			evidence: "native gate receipt native-capability.json",
		};
		const status = createStatus({
			capabilities: {
				jsonl: { available: true, label: "JSONL available" },
				database: { available: false, label: "Database unavailable", blocker },
			},
			activation: { native: false, verifiedTransfer: false, rollbackExport: false },
		});
		expect(modeActivationBlocker(status, "db")).toEqual(blocker);
		const service = new FakeStorageControlService(status);
		const updates: StorageControlResult[] = [];
		const controller = new StoragePanelController(service, {
			onUpdate(_nextStatus, result): void {
				if (result) updates.push(result);
			},
			onBusy(): void {},
		});
		await controller.initialize();
		const result = await controller.select("mode-db");
		expect(result?.outcome).toBe("blocked");
		expect(result?.blocker?.message).toContain("pinned Bun ABI");
		expect(service.calls).toEqual(["status", "status"]);
		expect(updates.at(-1)?.status.capabilities.jsonl.available).toBeTrue();
	});

	it("requires a transfer preview before the same terminal control can commit its verified job id", async () => {
		const service = new FakeStorageControlService(createStatus());
		const controller = new StoragePanelController(service, {
			onUpdate(): void {},
			onBusy(): void {},
		});
		await controller.initialize();
		const preview = await controller.select("synchronize");
		expect(preview?.outcome).toBe("preview");
		expect(preview?.message).toContain("Select this transfer again");
		const committed = await controller.select("synchronize");
		expect(committed?.outcome).toBe("completed");
		expect(service.calls).toEqual(["status", "preview:sync:true", "execute:sync:false:preview-1"]);
	});

	it("routes cancel and resume to the displayed durable job instead of inventing a new id", async () => {
		const service = new FakeStorageControlService(
			createStatus({
				activeJob: { jobId: "job-recover-4", state: "failed", direction: "db-to-jsonl" },
			}),
		);
		const controller = new StoragePanelController(service, {
			onUpdate(): void {},
			onBusy(): void {},
		});
		await controller.initialize();
		expect((await controller.select("cancel"))?.outcome).toBe("cancel-requested");
		expect((await controller.select("resume"))?.outcome).toBe("resumed");
		expect(service.calls).toEqual(["status", "cancel:job-recover-4", "resume:job-recover-4"]);
	});

	it("shows every required control, explicit mode/backend state, preview categories, and extension recovery choices", () => {
		const status = createStatus();
		const panel = new StoragePanelComponent(status, { onAction(): void {}, onCancel(): void {} });
		panel.update(status, createPreviewResult(status));
		const rendered = Bun.stripANSI(panel.render(160).join("\n"));
		for (const label of [
			"Use JSONL mode",
			"Use Database mode",
			"JSONL → DB",
			"DB → JSONL",
			"Synchronize both",
			"Verify",
			"Backup",
			"Recover",
			"Cancel after current batch",
			"Resume interrupted job",
		]) {
			expect(rendered).toContain(label);
		}
		expect(rendered).toContain("Mode  JSONL");
		expect(rendered).toContain("Active backend  OMP JSONL session repository");
		expect(rendered).toContain("3 versions · 5 extensions · 7 sibling forks · 11 duplicates · 13 quarantined");
		expect(rendered).toContain("export this branch to JSONL or keep JSONL mode");
		expect(rendered).toContain("No fallback or dual write");
	});
});
