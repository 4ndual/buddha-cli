import { checksumJobJson } from "../jobs/checksum";
import type { VerifiedBackupReceipt } from "./backup";

export const PINNED_RECOVERY_SCHEMA_VERSION = 1;

export interface SchemaRollbackGate {
	sourceSchemaVersion: number;
	targetSchemaVersion: number;
	backupId: string;
	backupSha256: string;
	backupReceiptChecksum: string;
	createdAt: string;
	gateChecksum: string;
}

function gateBody(gate: Omit<SchemaRollbackGate, "gateChecksum">) {
	return {
		sourceSchemaVersion: gate.sourceSchemaVersion,
		targetSchemaVersion: gate.targetSchemaVersion,
		backupId: gate.backupId,
		backupSha256: gate.backupSha256,
		backupReceiptChecksum: gate.backupReceiptChecksum,
		createdAt: gate.createdAt,
	};
}

export function createSchemaRollbackGate(options: {
	sourceSchemaVersion: number;
	targetSchemaVersion: number;
	backup: VerifiedBackupReceipt;
	now?: () => string;
}): SchemaRollbackGate {
	if (!Number.isSafeInteger(options.sourceSchemaVersion) || !Number.isSafeInteger(options.targetSchemaVersion)) {
		throw new Error("Schema versions must be safe integers");
	}
	if (options.targetSchemaVersion <= options.sourceSchemaVersion) {
		throw new Error("Rollback snapshots gate upgrades only");
	}
	const body = {
		sourceSchemaVersion: options.sourceSchemaVersion,
		targetSchemaVersion: options.targetSchemaVersion,
		backupId: options.backup.backupId,
		backupSha256: options.backup.sha256,
		backupReceiptChecksum: options.backup.receiptChecksum,
		createdAt: (options.now ?? (() => new Date().toISOString()))(),
	};
	return { ...body, gateChecksum: checksumJobJson(body) };
}

export function assertSchemaRollbackGate(
	gate: SchemaRollbackGate,
	expected: { sourceSchemaVersion: number; targetSchemaVersion: number; backup: VerifiedBackupReceipt },
): void {
	if (
		gate.sourceSchemaVersion !== expected.sourceSchemaVersion ||
		gate.targetSchemaVersion !== expected.targetSchemaVersion ||
		gate.backupId !== expected.backup.backupId ||
		gate.backupSha256 !== expected.backup.sha256 ||
		gate.backupReceiptChecksum !== expected.backup.receiptChecksum ||
		gate.gateChecksum !== checksumJobJson(gateBody(gate))
	) {
		throw new Error("Schema upgrade refused: verified rollback snapshot gate is missing or invalid");
	}
}

export function assertReadableSchema(actualVersion: number, supportedVersion = PINNED_RECOVERY_SCHEMA_VERSION): void {
	if (actualVersion > supportedVersion) {
		throw new Error(
			`Database schema ${actualVersion} is newer than standalone recovery schema ${supportedVersion}; use JSONL recovery or a matching recovery binary`,
		);
	}
	if (actualVersion < 1) throw new Error(`Invalid database schema version ${actualVersion}`);
}
