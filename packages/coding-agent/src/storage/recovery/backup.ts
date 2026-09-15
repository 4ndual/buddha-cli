import * as fs from "node:fs/promises";
import * as path from "node:path";
import { checksumJobJson } from "../jobs/checksum";
import { durableIo, type DurableIo, pathExists, writeJsonAtomicDurable } from "../jobs/durable-fs";

export interface SnapshotDescriptor {
	schemaVersion: number;
	engine: string;
	sourceGeneration: string;
	acknowledgedHeads: Readonly<Record<string, string>>;
}

export interface BackupAdapter {
	createSnapshot(destinationFile: string): Promise<SnapshotDescriptor>;
	verifySnapshot(snapshotFile: string): Promise<{ ok: boolean; issues: readonly string[] }>;
}

export interface VerifiedBackupReceipt {
	backupId: string;
	path: string;
	byteLength: number;
	sha256: string;
	descriptor: SnapshotDescriptor;
	createdAt: string;
	receiptChecksum: string;
}

function backupReceiptBody(receipt: Omit<VerifiedBackupReceipt, "receiptChecksum">) {
	return {
		backupId: receipt.backupId,
		path: receipt.path,
		byteLength: receipt.byteLength,
		sha256: receipt.sha256,
		descriptor: receipt.descriptor,
		createdAt: receipt.createdAt,
	};
}

async function syncExistingFile(filePath: string): Promise<void> {
	const handle = await fs.open(filePath, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function streamedFileHash(filePath: string): Promise<{ byteLength: number; sha256: string }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let byteLength = 0;
	for await (const chunk of Bun.file(filePath).stream()) {
		hasher.update(chunk);
		byteLength += chunk.byteLength;
	}
	return { byteLength, sha256: hasher.digest("hex") };
}

export async function createVerifiedBackup(options: {
	root: string;
	backupId: string;
	adapter: BackupAdapter;
	io?: DurableIo;
	now?: () => string;
}): Promise<VerifiedBackupReceipt> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.backupId)) throw new Error("Unsafe backup ID");
	const io = options.io ?? durableIo;
	await io.mkdir(options.root);
	const finalPath = path.join(options.root, options.backupId);
	if (await pathExists(finalPath, io)) {
		const receipt = JSON.parse(await io.readText(path.join(finalPath, "receipt.json"))) as VerifiedBackupReceipt;
		const observed = await streamedFileHash(path.join(finalPath, "snapshot.wcdb.sqlite"));
		if (
			receipt.backupId !== options.backupId ||
			receipt.path !== finalPath ||
			receipt.receiptChecksum !== checksumJobJson(backupReceiptBody(receipt)) ||
			observed.sha256 !== receipt.sha256 ||
			observed.byteLength !== receipt.byteLength
		) {
			throw new Error(`Existing backup ${options.backupId} failed receipt or snapshot checksum verification`);
		}
		return receipt;
	}
	const temporaryPath = path.join(options.root, `.${options.backupId}.${crypto.randomUUID()}.tmp`);
	await io.mkdir(temporaryPath);
	try {
		const snapshotFile = path.join(temporaryPath, "snapshot.wcdb.sqlite");
		const descriptor = await options.adapter.createSnapshot(snapshotFile);
		await syncExistingFile(snapshotFile);
		const verification = await options.adapter.verifySnapshot(snapshotFile);
		if (!verification.ok) throw new Error(`Backup verification failed: ${verification.issues.join("; ")}`);
		const observed = await streamedFileHash(snapshotFile);
		const createdAt = (options.now ?? (() => new Date().toISOString()))();
		const body = {
			backupId: options.backupId,
			path: finalPath,
			byteLength: observed.byteLength,
			sha256: observed.sha256,
			descriptor,
			createdAt,
		};
		const receipt: VerifiedBackupReceipt = { ...body, receiptChecksum: checksumJobJson(backupReceiptBody(body)) };
		await io.writeFile(path.join(temporaryPath, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
		await io.fsyncDirectory(temporaryPath);
		await io.rename(temporaryPath, finalPath);
		await io.fsyncDirectory(options.root);
		return receipt;
	} catch (error) {
		await io.remove(temporaryPath, true).catch(() => undefined);
		throw error;
	}
}

export interface SalvageAdapter {
	salvage(copiedSource: string, recoveredDestination: string): Promise<{
		recoveredRecords: number;
		lostRecords: number;
		warnings: readonly string[];
	}>;
	verify(recoveredDestination: string): Promise<{ ok: boolean; issues: readonly string[] }>;
}

export interface SalvageReport {
	schemaVersion: 1;
	sourcePath: string;
	sourceSha256: string;
	copyPath: string;
	recoveredPath: string;
	recoveredSha256: string;
	recoveredRecords: number;
	lostRecords: number;
	warnings: readonly string[];
	verified: boolean;
	createdAt: string;
	reportChecksum: string;
}

/** The salvage adapter receives only a copy and can never mutate the supplied source path. */
export async function salvageOnCopy(options: {
	sourcePath: string;
	workspaceRoot: string;
	adapter: SalvageAdapter;
	now?: () => string;
}): Promise<SalvageReport> {
	await fs.mkdir(options.workspaceRoot, { recursive: true, mode: 0o700 });
	const sourceBefore = await streamedFileHash(options.sourcePath);
	const copyPath = path.join(options.workspaceRoot, `source-${sourceBefore.sha256}.copy`);
	const recoveredPath = path.join(options.workspaceRoot, `recovered-${crypto.randomUUID()}.wcdb.sqlite`);
	try {
		await fs.copyFile(options.sourcePath, copyPath, fs.constants.COPYFILE_EXCL);
		await syncExistingFile(copyPath);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	const copied = await streamedFileHash(copyPath);
	if (copied.sha256 !== sourceBefore.sha256 || copied.byteLength !== sourceBefore.byteLength) {
		throw new Error("Salvage source copy failed checksum verification");
	}
	const result = await options.adapter.salvage(copyPath, recoveredPath);
	await syncExistingFile(recoveredPath);
	const verification = await options.adapter.verify(recoveredPath);
	const sourceAfter = await streamedFileHash(options.sourcePath);
	if (sourceAfter.sha256 !== sourceBefore.sha256 || sourceAfter.byteLength !== sourceBefore.byteLength) {
		throw new Error("Source changed during salvage; recovered output is not attributable to the recorded input");
	}
	const recovered = await streamedFileHash(recoveredPath);
	const body = {
		schemaVersion: 1 as const,
		sourcePath: options.sourcePath,
		sourceSha256: sourceBefore.sha256,
		copyPath,
		recoveredPath,
		recoveredSha256: recovered.sha256,
		recoveredRecords: result.recoveredRecords,
		lostRecords: result.lostRecords,
		warnings: [...result.warnings, ...verification.issues],
		verified: verification.ok,
		createdAt: (options.now ?? (() => new Date().toISOString()))(),
	};
	const report: SalvageReport = { ...body, reportChecksum: checksumJobJson(body) };
	await writeJsonAtomicDurable(path.join(options.workspaceRoot, "salvage-report.json"), report);
	return report;
}
