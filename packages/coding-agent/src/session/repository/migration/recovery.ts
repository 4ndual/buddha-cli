import { resolve } from "node:path";
import { verifyPublishedBundle } from "./bundle";
import { assertNoSymlinkComponents } from "./fencing";
import {
	readMigrationJob,
	recordPublicationReceipt,
	recordRecoveredCommitReceipt,
	type MigrationJobRecord,
} from "./jobs";

export interface RecoverPublishedExportOptions {
	/** Explicit containment root; no source, destination, or parent may traverse a symlink. */
	allowedRoot: string;
	publishedPath: string;
	journalPath: string;
}

export interface RecoveryResult {
	status: "already-recorded" | "receipt-recovered";
	manifestSha256: string;
	job: MigrationJobRecord;
}

/**
 * Recovers only the two explicit paths. It never scans, selects a mode, updates
 * production configuration, removes partial output, or initializes a DB driver.
 */
export async function recoverPublishedExport(options: RecoverPublishedExportOptions): Promise<RecoveryResult> {
	const root = resolve(options.allowedRoot);
	const publishedPath = await assertNoSymlinkComponents(root, options.publishedPath);
	const journalPath = await assertNoSymlinkComponents(root, options.journalPath);
	const verified = await verifyPublishedBundle(publishedPath);
	let job = await readMigrationJob(journalPath);
	if (job.kind !== "export") throw new Error(`Recovery expected an export job, got ${job.kind}`);
	if (job.items.length !== 1 || job.items[0].key !== verified.manifest.bundle_sha256) {
		throw new Error("Published bundle does not match the export job item");
	}
	if (job.publication) {
		if (job.publication.path !== publishedPath || job.publication.manifest_sha256 !== verified.manifestSha256) {
			throw new Error("Export job receipt identifies a different publication");
		}
		return { status: "already-recorded", manifestSha256: verified.manifestSha256, job };
	}
	if (job.cursor === 0) {
		job = await recordRecoveredCommitReceipt(journalPath, {
			receipt_id: verified.manifestSha256,
			item_keys: [job.items[0].key],
			commit_checksum: verified.manifest.bundle_sha256,
		});
	} else if (job.cursor !== 1) {
		throw new Error("Export job cursor cannot be reconciled with one publication");
	}
	job = await recordPublicationReceipt(journalPath, {
		path: publishedPath,
		manifestSha256: verified.manifestSha256,
	});
	return { status: "receipt-recovered", manifestSha256: verified.manifestSha256, job };
}

export async function runStandaloneRecovery(argv: readonly string[]): Promise<RecoveryResult> {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
			throw new Error("Usage: recovery --root PATH --published PATH --journal PATH");
		}
		if (!new Set(["--root", "--published", "--journal"]).has(flag) || values.has(flag)) {
			throw new Error(`Unknown or duplicate recovery argument: ${flag}`);
		}
		values.set(flag, value);
	}
	const allowedRoot = values.get("--root");
	const publishedPath = values.get("--published");
	const journalPath = values.get("--journal");
	if (!allowedRoot || !publishedPath || !journalPath || values.size !== 3) {
		throw new Error("Usage: recovery --root PATH --published PATH --journal PATH");
	}
	return recoverPublishedExport({ allowedRoot, publishedPath, journalPath });
}

if (import.meta.main) {
	try {
		const result = await runStandaloneRecovery(Bun.argv.slice(2));
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
