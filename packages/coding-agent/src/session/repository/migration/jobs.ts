import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalJson, sha256, type JsonValue } from "./bundle";

export const MIGRATION_JOB_FORMAT = "omp-migration-job-v1";

export type MigrationJobKind = "import" | "export" | "sync" | "recovery";
export type MigrationJobStatus = "pending" | "running" | "complete" | "failed";

export interface JobItemDescriptor {
	key: string;
	bytes: number;
	checksum: string;
}

export interface JobCommitReceipt {
	receipt_id: string;
	item_keys: readonly string[];
	commit_checksum: string;
}

export interface MigrationJobRecord {
	format: typeof MIGRATION_JOB_FORMAT;
	job_id: string;
	kind: MigrationJobKind;
	status: MigrationJobStatus;
	revision: number;
	max_batch_bytes: number;
	cursor: number;
	items: readonly JobItemDescriptor[];
	receipts: readonly JobCommitReceipt[];
	failure?: string;
	publication?: {
		path: string;
		manifest_sha256: string;
	};
}

export interface JobItem<T> extends JobItemDescriptor {
	value: T;
}

export interface RunJobOptions<T> {
	journalPath: string;
	items: readonly JobItem<T>[];
	executeBatch: (items: readonly JobItem<T>[], priorReceipts: readonly JobCommitReceipt[]) => Promise<JobCommitReceipt>;
	shouldCancel?: () => boolean | Promise<boolean>;
}

export async function createMigrationJob(
	journalPath: string,
	input: { jobId: string; kind: MigrationJobKind; maxBatchBytes: number; items: readonly JobItemDescriptor[] },
): Promise<MigrationJobRecord> {
	if (!input.jobId) throw new Error("jobId is required");
	if (!Number.isSafeInteger(input.maxBatchBytes) || input.maxBatchBytes <= 0) throw new Error("maxBatchBytes must be positive");
	assertItemDescriptors(input.items, input.maxBatchBytes);
	const keys = new Set<string>();
	for (const item of input.items) {
		if (keys.has(item.key)) throw new Error(`Duplicate job item key ${item.key}`);
		keys.add(item.key);
	}
	const record: MigrationJobRecord = {
		format: MIGRATION_JOB_FORMAT,
		job_id: input.jobId,
		kind: input.kind,
		status: "pending",
		revision: 0,
		max_batch_bytes: input.maxBatchBytes,
		cursor: 0,
		items: input.items,
		receipts: [],
	};
	await createJournal(journalPath, record);
	return record;
}

export async function readMigrationJob(journalPath: string): Promise<MigrationJobRecord> {
	const record = JSON.parse(await readFile(resolve(journalPath), "utf8")) as MigrationJobRecord;
	assertJobRecord(record);
	return record;
}

export async function runMigrationJob<T>(options: RunJobOptions<T>): Promise<MigrationJobRecord> {
	const journalPath = resolve(options.journalPath);
	let record = await readMigrationJob(journalPath);
	assertMatchingItems(record.items, options.items);
	if (record.status === "complete") return record;
	record = await updateJournal(journalPath, record.revision, clearFailure(record, { status: "running" }));
	try {
		while (record.cursor < options.items.length) {
			if (await options.shouldCancel?.()) return record;
			const batch = nextBatch(options.items, record.cursor, record.max_batch_bytes);
			const receipt = await options.executeBatch(batch, record.receipts);
			assertReceipt(receipt, batch);
			record = await updateJournal(journalPath, record.revision, {
				...record,
				cursor: record.cursor + batch.length,
				receipts: [...record.receipts, receipt],
			});
		}
		return await updateJournal(journalPath, record.revision, { ...record, status: "complete" });
	} catch (error) {
		const failure = error instanceof Error ? error.message : String(error);
		try {
			await updateJournal(journalPath, record.revision, { ...record, status: "failed", failure });
		} catch {
			// Keep the original operation failure. A later resume validates the durable cursor and receipts.
		}
		throw error;
	}
}

export async function recordPublicationReceipt(
	journalPath: string,
	publication: { path: string; manifestSha256: string },
): Promise<MigrationJobRecord> {
	const absolute = resolve(journalPath);
	const record = await readMigrationJob(absolute);
	if (record.publication) {
		if (record.publication.path !== resolve(publication.path) || record.publication.manifest_sha256 !== publication.manifestSha256) {
			throw new Error("Job already records a different publication");
		}
		return record;
	}
	return updateJournal(absolute, record.revision, {
		...record,
		publication: { path: resolve(publication.path), manifest_sha256: publication.manifestSha256 },
	});
}

/**
 * Records a commit proven by an external durable artifact after a crash between
 * the commit/publication and journal update. Only the exact next items advance.
 */
export async function recordRecoveredCommitReceipt(
	journalPath: string,
	receipt: JobCommitReceipt,
): Promise<MigrationJobRecord> {
	const absolute = resolve(journalPath);
	const record = await readMigrationJob(absolute);
	if (record.receipts.some((existing) => existing.receipt_id === receipt.receipt_id)) return record;
	const expected = record.items.slice(record.cursor, record.cursor + receipt.item_keys.length);
	assertReceipt(receipt, expected);
	const cursor = record.cursor + expected.length;
	return updateJournal(
		absolute,
		record.revision,
		clearFailure(record, {
			cursor,
			receipts: [...record.receipts, receipt],
			status: cursor === record.items.length ? "complete" : "running",
		}),
	);
}

export function checksumJobValue(value: JsonValue): string {
	return sha256(canonicalJson(value));
}

function clearFailure(
	record: MigrationJobRecord,
	changes: Partial<MigrationJobRecord>,
): MigrationJobRecord {
	const { failure: _failure, ...withoutFailure } = record;
	return { ...withoutFailure, ...changes };
}

function nextBatch<T>(items: readonly JobItem<T>[], cursor: number, maxBytes: number): readonly JobItem<T>[] {
	let bytes = 0;
	let end = cursor;
	while (end < items.length) {
		const next = items[end];
		if (end > cursor && bytes + next.bytes > maxBytes) break;
		if (next.bytes > maxBytes) throw new Error(`Job item ${next.key} exceeds byte bound`);
		bytes += next.bytes;
		end += 1;
	}
	if (end === cursor) throw new Error("Unable to form a non-empty bounded batch");
	return items.slice(cursor, end);
}

function assertReceipt(receipt: JobCommitReceipt, batch: readonly JobItemDescriptor[]): void {
	if (!receipt.receipt_id || !receipt.commit_checksum) throw new Error("Commit receipt is incomplete");
	if (receipt.item_keys.length !== batch.length || receipt.item_keys.some((key, index) => key !== batch[index].key)) {
		throw new Error("Commit receipt does not match the executed batch");
	}
}

function assertMatchingItems(expected: readonly JobItemDescriptor[], actual: readonly JobItemDescriptor[]): void {
	if (expected.length !== actual.length) throw new Error("Job item set changed since creation");
	for (let index = 0; index < expected.length; index += 1) {
		const left = expected[index];
		const right = actual[index];
		if (left.key !== right.key || left.bytes !== right.bytes || left.checksum !== right.checksum) {
			throw new Error(`Job item ${index} changed since creation`);
		}
	}
}

function assertItemDescriptors(items: readonly JobItemDescriptor[], maxBatchBytes: number): void {
	for (const item of items) {
		if (!item.key || !item.checksum) throw new Error("Job item key and checksum are required");
		if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error(`Invalid byte count for ${item.key}`);
		if (item.bytes > maxBatchBytes) throw new Error(`Job item ${item.key} exceeds byte bound`);
	}
}

function assertJobRecord(record: MigrationJobRecord): void {
	if (record.format !== MIGRATION_JOB_FORMAT) throw new Error("Unsupported migration job format");
	if (!Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error("Invalid job revision");
	if (!Number.isSafeInteger(record.cursor) || record.cursor < 0 || record.cursor > record.items.length) {
		throw new Error("Invalid durable job cursor");
	}
	assertItemDescriptors(record.items, record.max_batch_bytes);
	const committed = record.receipts.reduce((count, receipt) => count + receipt.item_keys.length, 0);
	if (committed !== record.cursor) throw new Error("Job cursor is not tied to its commit receipts");
}

async function createJournal(path: string, record: MigrationJobRecord): Promise<void> {
	const absolute = resolve(path);
	await mkdir(dirname(absolute), { recursive: true });
	const handle = await open(absolute, "wx");
	try {
		await handle.writeFile(`${canonicalJson(record as unknown as JsonValue)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fsyncDirectory(dirname(absolute));
}

async function updateJournal(path: string, expectedRevision: number, next: MigrationJobRecord): Promise<MigrationJobRecord> {
	return withJournalLock(path, async () => {
		const current = await readMigrationJob(path);
		if (current.revision !== expectedRevision) throw new Error("Migration job was modified concurrently");
		const updated = { ...next, revision: expectedRevision + 1 };
		assertJobRecord(updated);
		const temporary = `${path}.next-${updated.revision}`;
		await writeFile(temporary, `${canonicalJson(updated as unknown as JsonValue)}\n`, { flag: "wx" });
		const handle = await open(temporary, constants.O_RDONLY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		await fsyncDirectory(dirname(path));
		return updated;
	});
}

async function withJournalLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = `${path}.lock`;
	const lock = await open(lockPath, "wx").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "EEXIST") throw new Error(`Migration job is locked: ${path}`);
		throw error;
	});
	try {
		return await operation();
	} finally {
		await lock.close();
		await rm(lockPath, { force: true });
	}
}

async function fsyncDirectory(path: string): Promise<void> {
	const directory = await open(path, constants.O_RDONLY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
