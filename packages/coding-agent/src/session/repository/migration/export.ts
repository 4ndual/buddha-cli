import {
	assertLogicalBundle,
	canonicalJson,
	publishLogicalBundle,
	sha256,
	verifyPublishedBundle,
	type LogicalBranch,
	type LogicalBundle,
	type LogicalEvent,
	type LogicalVersion,
	type PublishedBundle,
} from "./bundle";
import {
	createMigrationJob,
	readMigrationJob,
	recordPublicationReceipt,
	runMigrationJob,
	type JobCommitReceipt,
	type JobItem,
	type MigrationJobRecord,
} from "./jobs";

/** readLogicalSnapshot must pin one repository read snapshot/cutoff for the duration of the call. */
export interface LogicalExportSource {
	readLogicalSnapshot(): Promise<LogicalBundle>;
}

export interface ExportSelection {
	originId?: string;
	branchId?: string;
	allBranches?: boolean;
}

export interface ExportLogicalBundleOptions {
	jobId: string;
	journalPath: string;
	allowedRoot: string;
	destination: string;
	generationId: string;
	maxBatchBytes: number;
	selection?: ExportSelection;
	validate?: (bundle: LogicalBundle) => void | Promise<void>;
	/** Test/fault hook: publication is durable but its job receipt has not been recorded yet. */
	afterPublishBeforeReceipt?: (publication: PublishedBundle) => void | Promise<void>;
}

export interface ExportLogicalBundleResult {
	job: MigrationJobRecord;
	publication: PublishedBundle;
	bundle: LogicalBundle;
}

export async function exportLogicalBundle(
	source: LogicalExportSource,
	options: ExportLogicalBundleOptions,
): Promise<ExportLogicalBundleResult> {
	const snapshot = await source.readLogicalSnapshot();
	assertLogicalBundle(snapshot);
	const bundle = selectLogicalBundle(snapshot, options.selection);
	await options.validate?.(bundle);
	const encoded = canonicalJson(bundle);
	const item: JobItem<LogicalBundle> = {
		key: sha256(encoded),
		bytes: Buffer.byteLength(encoded),
		checksum: sha256(encoded),
		value: bundle,
	};
	let job: MigrationJobRecord;
	try {
		job = await readMigrationJob(options.journalPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		job = await createMigrationJob(options.journalPath, {
			jobId: options.jobId,
			kind: "export",
			maxBatchBytes: options.maxBatchBytes,
			items: [item],
		});
	}
	let publication: PublishedBundle | undefined;
	job = await runMigrationJob({
		journalPath: options.journalPath,
		items: [item],
		executeBatch: async (): Promise<JobCommitReceipt> => {
			publication = await publishOrRecover(bundle, options);
			await options.afterPublishBeforeReceipt?.(publication);
			return {
				receipt_id: publication.manifestSha256,
				item_keys: [item.key],
				commit_checksum: publication.manifest.bundle_sha256,
			};
		},
	});
	if (!publication) {
		const verified = await verifyPublishedBundle(options.destination);
		publication = verified;
	}
	job = await recordPublicationReceipt(options.journalPath, {
		path: publication.path,
		manifestSha256: publication.manifestSha256,
	});
	return { job, publication, bundle };
}

export function selectLogicalBundle(snapshot: LogicalBundle, selection: ExportSelection = {}): LogicalBundle {
	if (selection.branchId && selection.allBranches) throw new Error("branchId and allBranches are mutually exclusive");
	let branches: readonly LogicalBranch[] = snapshot.branches;
	if (selection.branchId) {
		const selected = snapshot.branches.find((branch) => branch.branch_id === selection.branchId);
		if (!selected) throw new Error(`Unknown branch ${selection.branchId}`);
		branches = [selected];
	} else if (selection.originId) {
		branches = snapshot.branches.filter((branch) => branch.origin_id === selection.originId);
		if (branches.length === 0) throw new Error(`Unknown origin ${selection.originId}`);
	} else if (!selection.allBranches) {
		// A full archive is explicit when no narrower selector is supplied.
		branches = snapshot.branches;
	}
	const selectedOrigins = new Set(branches.map((branch) => branch.origin_id));
	const selectedVersionIds = collectVersionIds(branches, snapshot.versions);
	const versions = snapshot.versions.filter((version) => selectedVersionIds.has(version.version_id));
	const eventHashes = collectEventHashes(versions, snapshot.events);
	const events = snapshot.events.filter((event) => eventHashes.has(event.event_hash));
	const bundle: LogicalBundle = {
		format: snapshot.format,
		replica_id: snapshot.replica_id,
		origins: snapshot.origins.filter((origin) => selectedOrigins.has(origin)),
		events,
		versions,
		branches,
	};
	assertLogicalBundle(bundle);
	return bundle;
}

async function publishOrRecover(bundle: LogicalBundle, options: ExportLogicalBundleOptions): Promise<PublishedBundle> {
	try {
		return await publishLogicalBundle(bundle, {
			allowedRoot: options.allowedRoot,
			destination: options.destination,
			generationId: options.generationId,
			validate: options.validate,
		});
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("Refusing to replace existing path:")) throw error;
		const verified = await verifyPublishedBundle(options.destination);
		if (verified.manifest.generation_id !== options.generationId) {
			throw new Error("Existing publication belongs to a different generation");
		}
		if (verified.manifest.bundle_sha256 !== sha256(canonicalJson(bundle))) {
			throw new Error("Existing publication does not match the requested export");
		}
		return verified;
	}
}

function collectVersionIds(branches: readonly LogicalBranch[], versions: readonly LogicalVersion[]): ReadonlySet<string> {
	const byId = new Map(versions.map((version) => [version.version_id, version]));
	const selected = new Set<string>();
	for (const branch of branches) {
		let cursor: string | null = branch.head_version_id;
		while (cursor !== null) {
			if (selected.has(cursor)) break;
			const version = byId.get(cursor);
			if (!version) throw new Error(`Missing version ${cursor} for branch ${branch.branch_id}`);
			selected.add(cursor);
			cursor = version.parent_version_id;
		}
	}
	return selected;
}

function collectEventHashes(versions: readonly LogicalVersion[], events: readonly LogicalEvent[]): ReadonlySet<string> {
	const byHash = new Map(events.map((event) => [event.event_hash, event]));
	const selected = new Set<string>();
	for (const version of versions) {
		let cursor = version.head_hash;
		while (cursor !== null) {
			if (selected.has(cursor)) break;
			const event = byHash.get(cursor);
			if (!event) throw new Error(`Missing event ${cursor} for version ${version.version_id}`);
			selected.add(cursor);
			cursor = event.parent_hash;
		}
	}
	return selected;
}
