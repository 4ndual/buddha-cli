import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	LOGICAL_BUNDLE_FORMAT,
	canonicalJson,
	publishLogicalBundle,
	sha256,
	verifyPublishedBundle,
	type JsonValue,
	type LogicalBranch,
	type LogicalBundle,
	type LogicalEvent,
	type LogicalVersion,
} from "../../../src/session/repository/migration/bundle";
import { exportLogicalBundle } from "../../../src/session/repository/migration/export";
import { recoverPublishedExport } from "../../../src/session/repository/migration/recovery";

const timestamp = "2026-09-15T12:00:00.000Z";

function logicalEvent(hash: string, parentHash: string | null, payload: JsonValue): LogicalEvent {
	return {
		event_hash: hash,
		origin_id: "origin:fixture:round-trip",
		parent_hash: parentHash,
		native_entry_id: `native-${hash}`,
		kind: "message",
		timestamp,
		payload_hash: sha256(canonicalJson(payload)),
		payload,
	};
}

function logicalVersion(
	versionId: string,
	branchId: string,
	headHash: string,
	parentVersionId: string | null,
	forkPointHash: string | null,
): LogicalVersion {
	return {
		version_id: versionId,
		origin_id: "origin:fixture:round-trip",
		branch_id: branchId,
		parent_version_id: parentVersionId,
		head_hash: headHash,
		fork_point_hash: forkPointHash,
		metadata_revision_id: `metadata:${versionId}`,
		metadata: {
			title: `Title ${versionId}`,
			source_alias: "fixture-install/native-session-duplicate-safe",
		},
	};
}

function forkedBundle(largePayloadBytes = 0): LogicalBundle {
	const binary = new Uint8Array([0, 1, 2, 255, 128, 13, 10, 42]);
	const payloadText = largePayloadBytes > 0 ? "x".repeat(largePayloadBytes) : "shared-prefix";
	const events = [
		logicalEvent("event-A", null, { text: payloadText }),
		logicalEvent("event-B", "event-A", {
			attachment_base64: Buffer.from(binary).toString("base64"),
			attachment_sha256: sha256(binary),
		}),
		logicalEvent("event-C", "event-B", { text: "left continuation" }),
		logicalEvent("event-D", "event-B", { text: "right continuation" }),
	];
	const versions = [
		logicalVersion("version-B", "branch-base", "event-B", null, null),
		logicalVersion("version-C", "branch-left", "event-C", "version-B", "event-B"),
		logicalVersion("version-D", "branch-right", "event-D", "version-B", "event-B"),
	];
	const branches: LogicalBranch[] = [
		{
			branch_id: "branch-left",
			origin_id: "origin:fixture:round-trip",
			parent_branch_id: "branch-base",
			fork_point_hash: "event-B",
			head_hash: "event-C",
			head_version_id: "version-C",
		},
		{
			branch_id: "branch-right",
			origin_id: "origin:fixture:round-trip",
			parent_branch_id: "branch-base",
			fork_point_hash: "event-B",
			head_hash: "event-D",
			head_version_id: "version-D",
		},
	];
	return {
		format: LOGICAL_BUNDLE_FORMAT,
		replica_id: "replica:fixture:source",
		origins: ["origin:fixture:round-trip"],
		events,
		versions,
		branches,
	};
}

describe("Turso logical transfer fault gates", () => {
	it("keeps a fully written generation unpublished when interrupted before atomic rename", async () => {
		using temp = TempDir.createSync("@omp-turso-publish-interrupt-");
		const destination = path.join(temp.path(), "published-generation");
		await expect(
			publishLogicalBundle(forkedBundle(), {
				allowedRoot: temp.path(),
				destination,
				generationId: "interrupted",
				beforePublish(stagingPath) {
					return Bun.file(path.join(stagingPath, "COMPLETE")).exists().then(complete => {
						expect(complete).toBe(true);
						throw new Error("injected publication interruption");
					});
				},
			}),
		).rejects.toThrow("injected publication interruption");

		expect(await Bun.file(path.join(destination, "COMPLETE")).exists()).toBe(false);
		expect((await fs.readdir(temp.path())).some(entry => entry.endsWith(".partial"))).toBe(false);
	});

	it("recovers a durable export interrupted before its receipt without republishing or changing identity", async () => {
		using temp = TempDir.createSync("@omp-turso-export-receipt-");
		const sourceBundle = forkedBundle();
		const destination = path.join(temp.path(), "published-generation");
		const journalPath = path.join(temp.path(), "export.job.json");
		await expect(
			exportLogicalBundle(
				{ async readLogicalSnapshot() { return structuredClone(sourceBundle); } },
				{
					jobId: "round-trip-export",
					journalPath,
					allowedRoot: temp.path(),
					destination,
					generationId: "generation-1",
					maxBatchBytes: 1024 * 1024,
					selection: { allBranches: true },
					afterPublishBeforeReceipt() {
						throw new Error("injected receipt interruption");
					},
				},
			),
		).rejects.toThrow("injected receipt interruption");
		const publishedBeforeRecovery = await verifyPublishedBundle(destination, { allowedRoot: temp.path() });

		const recovered = await recoverPublishedExport({ allowedRoot: temp.path(), publishedPath: destination, journalPath });
		const publishedAfterRecovery = await verifyPublishedBundle(destination, { allowedRoot: temp.path() });
		expect(recovered.status).toBe("receipt-recovered");
		expect(publishedAfterRecovery.manifestSha256).toBe(publishedBeforeRecovery.manifestSha256);
		expect(canonicalJson(publishedAfterRecovery.bundle)).toBe(canonicalJson(sourceBundle));
		expect(publishedAfterRecovery.bundle.branches.map(branch => branch.branch_id).sort()).toEqual([
			"branch-left",
			"branch-right",
		]);
		expect(publishedAfterRecovery.bundle.events[1]?.payload).toEqual({
			attachment_base64: "AAEC/4ANCio=",
			attachment_sha256: "afca51f96113269865b8da9d9ceba62c058acf512072edc7191358ba3c6206f5",
		});
	});

	it("never publishes a generation after an OS-enforced short write", async () => {
		using temp = TempDir.createSync("@omp-turso-short-write-");
		const childPath = path.join(temp.path(), "publish-under-limit.ts");
		const destination = path.join(temp.path(), "limited-generation");
		const bundleModule = path.resolve(import.meta.dir, "../../../src/session/repository/migration/bundle.ts");
		const bundle = forkedBundle(64 * 1024);
		await Bun.write(
			childPath,
			`import { publishLogicalBundle } from ${JSON.stringify(bundleModule)};
const bundle = ${JSON.stringify(bundle)};
await publishLogicalBundle(bundle, {
	allowedRoot: ${JSON.stringify(temp.path())},
	destination: ${JSON.stringify(destination)},
	generationId: "file-size-limited",
});
`,
		);

		const subprocess = Bun.spawn(
			["prlimit", "--fsize=4096:4096", process.execPath, childPath],
			{ cwd: temp.path(), stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stderr] = await Promise.all([
			subprocess.exited,
			new Response(subprocess.stderr).text(),
		]);
		expect(exitCode).not.toBe(0);
		expect(stderr.length).toBeGreaterThan(0);
		expect(await Bun.file(path.join(destination, "COMPLETE")).exists()).toBe(false);
	});
});
