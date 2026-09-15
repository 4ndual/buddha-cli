import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { classifySourceContent, type ContentClassification } from "./adapters";

const INVENTORY_SCHEMA_VERSION = "omp-migration-inventory-v1";
const DEFAULT_SNIFF_BYTES = 64 * 1024;
const DEFAULT_READ_BYTES = 128 * 1024;
const DEFAULT_ATTEMPTS = 3;

export type MetadataProvenance = "source-recorded" | "externally-recorded" | "inferred" | "unknown";
export type InventoryStatus = "copied" | "excluded" | "pending" | "quarantined";
export type InventoryItemKind = "file" | "symlink" | "other" | "inaccessible";

export interface DesignatedSourceRoot {
	readonly path: string;
	readonly rootId: string;
	readonly installationNamespace: string;
	readonly runtime: { readonly name: string; readonly version: string };
}

export interface MetadataObservation {
	readonly key: string;
	readonly value?: string | number | boolean;
	readonly provenance: MetadataProvenance;
	readonly status: "present" | "conflicting" | "unknown";
	readonly acquiredAt: string;
	readonly locator: string;
}

export interface InventoryDisposition {
	readonly code: string;
	readonly reason: string;
	readonly evidence: readonly string[];
}

export interface OriginalFileAccounting {
	readonly sha256?: string;
	readonly size: string;
	readonly mode: number;
	readonly modifiedAt: string;
	readonly changedAt: string;
	readonly createdAt: string;
	readonly modifiedNs: string;
	readonly changedNs: string;
	readonly device: string;
	readonly inode: string;
	readonly linkCount: string;
	readonly changedDuringRead: boolean;
	readonly readAttempts: number;
}

export interface CopiedFileAccounting {
	readonly path: string;
	readonly sha256: string;
	readonly size: string;
	readonly mode: number;
}

export interface InventoryItem {
	readonly schemaVersion: typeof INVENTORY_SCHEMA_VERSION;
	readonly itemId: string;
	readonly rootId: string;
	readonly sourceNamespace: string;
	readonly sourcePath: string;
	readonly relativePath: string;
	readonly kind: InventoryItemKind;
	readonly classification: ContentClassification;
	readonly original?: OriginalFileAccounting;
	readonly snapshotAt: string;
	readonly status: InventoryStatus;
	readonly copied?: CopiedFileAccounting;
	readonly disposition?: InventoryDisposition;
	readonly metadataObservations: readonly MetadataObservation[];
}

export interface InventoryPreflight {
	readonly ok: boolean;
	readonly filesystemPath: string;
	readonly availableBytes: string;
	readonly requiredBytes: string;
	readonly copyBytes: string;
	readonly expansionFactor: number;
	readonly reserveBytes: string;
}

export interface InventorySummary {
	readonly discovered: number;
	readonly accounted: number;
	readonly copied: number;
	readonly excluded: number;
	readonly pending: number;
	readonly quarantined: number;
	readonly discoveredBytes: string;
	readonly copiedBytes: string;
	readonly aggregateSha256: string;
}

export interface InventoryManifest {
	readonly schemaVersion: typeof INVENTORY_SCHEMA_VERSION;
	readonly snapshotAt: string;
	readonly roots: ReadonlyArray<{
		readonly rootId: string;
		readonly sourceNamespace: string;
		readonly runtime: { readonly name: string; readonly version: string };
	}>;
	readonly backupRoot: string;
	readonly preflight: InventoryPreflight;
	readonly items: readonly InventoryItem[];
	readonly summary: InventorySummary;
}

export interface InventoryOptions {
	readonly roots: readonly DesignatedSourceRoot[];
	readonly backupRoot: string;
	readonly snapshotAt?: string;
	readonly sniffBytes?: number;
	readonly readBytes?: number;
	readonly maxReadAttempts?: number;
	readonly expansionFactor?: number;
	readonly reserveBytes?: bigint;
	readonly maxDepth?: number;
	readonly maxItems?: number;
	readonly onReadProgress?: (event: {
		readonly sourcePath: string;
		readonly bytesRead: number;
		readonly attempt: number;
	}) => void | Promise<void>;
	readonly signal?: AbortSignal;
}

interface DiscoveredItem {
	readonly root: DesignatedSourceRoot;
	readonly sourceNamespace: string;
	readonly sourcePath: string;
	readonly relativePath: string;
	readonly kind: InventoryItemKind;
	readonly discoveryError?: string;
}

interface SnapshotRead {
	readonly accounting: OriginalFileAccounting;
	readonly prefix: Uint8Array;
	readonly prefixIsComplete: boolean;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException("Inventory cancelled", "AbortError");
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Build a stable namespace from explicit runtime and installation identity, never a mutable file path. */
export function stableSourceNamespace(root: DesignatedSourceRoot): string {
	for (const [field, value] of [
		["rootId", root.rootId],
		["installationNamespace", root.installationNamespace],
		["runtime.name", root.runtime.name],
		["runtime.version", root.runtime.version],
	] as const) {
		if (!value.trim() || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${field}`);
	}
	return `${encodeURIComponent(root.runtime.name)}@${encodeURIComponent(root.runtime.version)}/${encodeURIComponent(root.installationNamespace)}`;
}

function itemId(sourceNamespace: string, rootId: string, relativePath: string): string {
	return sha256(`${sourceNamespace}\0${rootId}\0${relativePath}`);
}

function isoFromNs(nanoseconds: bigint): string {
	return new Date(Number(nanoseconds / 1_000_000n)).toISOString();
}

function originalAccounting(stats: BigIntStats, digest: string | undefined, changed: boolean, attempts: number): OriginalFileAccounting {
	return {
		sha256: digest,
		size: stats.size.toString(),
		mode: Number(stats.mode & 0o7777n),
		modifiedAt: isoFromNs(stats.mtimeNs),
		changedAt: isoFromNs(stats.ctimeNs),
		createdAt: isoFromNs(stats.birthtimeNs),
		modifiedNs: stats.mtimeNs.toString(),
		changedNs: stats.ctimeNs.toString(),
		device: stats.dev.toString(),
		inode: stats.ino.toString(),
		linkCount: stats.nlink.toString(),
		changedDuringRead: changed,
		readAttempts: attempts,
	};
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mode === right.mode &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

async function readStableSnapshot(
	filePath: string,
	sniffBytes: number,
	readBytes: number,
	maxAttempts: number,
	signal: AbortSignal | undefined,
	onReadProgress?: InventoryOptions["onReadProgress"],
): Promise<SnapshotRead> {
	let lastAccounting: OriginalFileAccounting | undefined;
	let lastPrefix = new Uint8Array();
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		assertNotAborted(signal);
		const beforePath = await fs.lstat(filePath, { bigint: true });
		const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const before = await handle.stat({ bigint: true });
			if (!before.isFile() || !sameFileState(beforePath, before)) throw new Error("source path identity changed before read");
			const hasher = createHash("sha256");
			const prefix = new Uint8Array(Math.min(sniffBytes, Number(before.size)));
			const buffer = Buffer.allocUnsafe(readBytes);
			let prefixOffset = 0;
			let position = 0;
			while (true) {
				assertNotAborted(signal);
				const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
				if (bytesRead === 0) break;
				const bytes = buffer.subarray(0, bytesRead);
				hasher.update(bytes);
				if (prefixOffset < prefix.byteLength) {
					const count = Math.min(bytesRead, prefix.byteLength - prefixOffset);
					prefix.set(bytes.subarray(0, count), prefixOffset);
					prefixOffset += count;
				}
				position += bytesRead;
				await onReadProgress?.({ sourcePath: filePath, bytesRead: position, attempt });
			}
			const after = await handle.stat({ bigint: true });
			const afterPath = await fs.lstat(filePath, { bigint: true });
			const digest = hasher.digest("hex");
			const changed = !sameFileState(before, after) || !sameFileState(after, afterPath) || BigInt(position) !== after.size;
			lastAccounting = originalAccounting(after, digest, changed, attempt);
			lastPrefix = prefix;
			if (!changed) return { accounting: lastAccounting, prefix, prefixIsComplete: after.size <= BigInt(sniffBytes) };
		} finally {
			await handle.close();
		}
	}
	if (!lastAccounting) throw new Error("source could not be read");
	return { accounting: lastAccounting, prefix: lastPrefix, prefixIsComplete: false };
}

async function* walkRoot(root: DesignatedSourceRoot, maxDepth: number): AsyncGenerator<DiscoveredItem> {
	const sourceNamespace = stableSourceNamespace(root);
	const rootPath = path.resolve(root.path);
	const rootStats = await fs.lstat(rootPath).catch(() => undefined);
	if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
		yield {
			root,
			sourceNamespace,
			sourcePath: rootPath,
			relativePath: ".",
			kind: rootStats?.isSymbolicLink() ? "symlink" : "inaccessible",
			discoveryError: rootStats ? "designated root is not a real directory" : "designated root is inaccessible",
		};
		return;
	}
	const walk = async function* (directory: string, depth: number): AsyncGenerator<DiscoveredItem> {
		if (depth > maxDepth) {
			yield {
				root,
				sourceNamespace,
				sourcePath: directory,
				relativePath: path.relative(rootPath, directory) || ".",
				kind: "inaccessible",
				discoveryError: `directory depth exceeds configured limit ${maxDepth}`,
			};
			return;
		}
		let entries;
		try {
			const directoryStats = await fs.lstat(directory);
			if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
				throw new Error("directory path was replaced or became a symlink");
			}
			const opened = await fs.opendir(directory);
			entries = [];
			for await (const entry of opened) entries.push(entry);
			entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
		} catch (error) {
			yield {
				root,
				sourceNamespace,
				sourcePath: directory,
				relativePath: path.relative(rootPath, directory) || ".",
				kind: "inaccessible",
				discoveryError: error instanceof Error ? error.message : String(error),
			};
			return;
		}
		for (const entry of entries) {
			const sourcePath = path.join(directory, entry.name);
			const relativePath = path.relative(rootPath, sourcePath).split(path.sep).join("/");
			if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
				yield {
					root,
					sourceNamespace,
					sourcePath,
					relativePath,
					kind: "inaccessible",
					discoveryError: "discovered path escaped designated root",
				};
			} else if (entry.isDirectory()) {
				yield* walk(sourcePath, depth + 1);
			} else {
				yield {
					root,
					sourceNamespace,
					sourcePath,
					relativePath,
					kind: entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
				};
			}
		}
	};
	yield* walk(rootPath, 0);
}

function extractedMetadata(
	prefix: Uint8Array,
	classification: ContentClassification,
	snapshotAt: string,
	relativePath: string,
): MetadataObservation[] {
	if (!classification.format.includes("jsonl")) return [];
	const observations: MetadataObservation[] = [];
	const lines = new TextDecoder().decode(prefix).split(/\r?\n/).slice(0, 64);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(record)) continue;
		for (const [key, raw] of [
			["native_session_id", record.id ?? record.sessionId ?? record.session_id],
			["cwd", record.cwd],
			["timestamp", record.timestamp],
			["model", isRecord(record.message) ? record.message.model : undefined],
		] as const) {
			if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue;
			if (observations.some(observation => observation.key === key && observation.value === raw)) continue;
			observations.push({
				key,
				value: raw,
				provenance: "source-recorded",
				status: observations.some(observation => observation.key === key) ? "conflicting" : "present",
				acquiredAt: snapshotAt,
				locator: `${relativePath}:line:${index + 1}`,
			});
		}
	}
	for (const key of ["native_session_id", "cwd", "timestamp"] as const) {
		if (observations.some(observation => observation.key === key)) continue;
		observations.push({
			key,
			provenance: "unknown",
			status: "unknown",
			acquiredAt: snapshotAt,
			locator: relativePath,
		});
	}
	return observations;
}

function exclusionFor(
	discovered: DiscoveredItem,
	classification: ContentClassification,
	accounting: OriginalFileAccounting | undefined,
	prefix: Uint8Array,
): InventoryDisposition | undefined {
	if (discovered.kind !== "file") {
		return {
			code: discovered.kind === "symlink" ? "symlink-not-followed" : "unsupported-filesystem-entry",
			reason: "Only regular files are read or copied; links and special entries are accounted without traversal",
			evidence: [discovered.discoveryError ?? discovered.kind],
		};
	}
	if (!accounting?.sha256) return undefined;
	const base = path.basename(discovered.relativePath);
	if (/^(?:\.env(?:\..*)?|credentials?(?:\..*)?|auth(?:entication)?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(base)) {
		return {
			code: "sensitive-material-excluded",
			reason: "Credential-like source names are hashed for accounting but never copied into migration material",
			evidence: ["conservative sensitive basename policy"],
		};
	}
	const prefixText = new TextDecoder().decode(prefix.subarray(0, Math.min(prefix.byteLength, 8 * 1024)));
	if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(prefixText)) {
		return {
			code: "sensitive-material-excluded",
			reason: "Private-key content is hashed for accounting but never copied",
			evidence: ["private key content marker"],
		};
	}
	if (
		(classification.format === "generic-jsonl" ||
			classification.format === "bundle-manifest" ||
			classification.format === "unknown-text") &&
		/"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|secret)"\s*:/i.test(prefixText)
	) {
		return {
			code: "sensitive-material-excluded",
			reason: "Secret-shaped generic metadata is hashed for accounting but never copied",
			evidence: ["conservative secret-key content policy"],
		};
	}
	if (accounting.linkCount !== "1") {
		return {
			code: "hardlink-excluded",
			reason: "Multiply-linked files are not copied because they may alias protected active state",
			evidence: [`linkCount=${accounting.linkCount}`],
		};
	}
	const executableMagic =
		(prefix[0] === 0x7f && prefix[1] === 0x45 && prefix[2] === 0x4c && prefix[3] === 0x46) ||
		(prefix[0] === 0x4d && prefix[1] === 0x5a);
	if (executableMagic || (accounting.mode & 0o111) !== 0) {
		return {
			code: "executable-excluded",
			reason: "Executable material is outside session migration scope and is not copied",
			evidence: [executableMagic ? "executable content signature" : "filesystem execute permission"],
		};
	}
	if (classification.format === "sqlite-database") {
		return {
			code: "database-snapshot-required",
			reason: "A database main file cannot be copied without a caller-provided consistent snapshot",
			evidence: classification.evidence,
		};
	}
	if (classification.format === "binary") {
		return {
			code: "unrecognized-binary-excluded",
			reason: "Unrecognized binary content is not blindly ingested",
			evidence: classification.evidence,
		};
	}
	return undefined;
}

function pendingItem(discovered: DiscoveredItem, snapshotAt: string, reason: string): InventoryItem {
	return {
		schemaVersion: INVENTORY_SCHEMA_VERSION,
		itemId: itemId(discovered.sourceNamespace, discovered.root.rootId, discovered.relativePath),
		rootId: discovered.root.rootId,
		sourceNamespace: discovered.sourceNamespace,
		sourcePath: discovered.sourcePath,
		relativePath: discovered.relativePath,
		kind: discovered.kind,
		classification: {
			format: "empty",
			version: "unknown",
			confidence: "weak",
			evidence: ["content unavailable"],
			malformedRecords: 0,
			truncated: false,
		},
		snapshotAt,
		status: "pending",
		disposition: { code: "read-pending", reason, evidence: [reason] },
		metadataObservations: [],
	};
}

async function assertNoSymlinkPath(root: string, targetDirectory: string): Promise<void> {
	const absoluteRoot = path.resolve(root);
	const relative = path.relative(absoluteRoot, path.resolve(targetDirectory));
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Target directory escaped owned root");
	let current = absoluteRoot;
	for (const component of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		const stats = await fs.lstat(current);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe destination component: ${current}`);
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function publishNoClobber(temporary: string, destination: string): Promise<"published" | "identical"> {
	try {
		await fs.link(temporary, destination);
		await fs.rm(temporary);
		await syncDirectory(path.dirname(destination));
		return "published";
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") throw error;
		const destinationStats = await fs.lstat(destination);
		if (!destinationStats.isFile() || destinationStats.isSymbolicLink() || destinationStats.nlink !== 1) {
			throw new Error(`Unsafe existing output: ${destination}`);
		}
		const [temporaryBytes, destinationBytes] = await Promise.all([fs.readFile(temporary), fs.readFile(destination)]);
		if (!temporaryBytes.equals(destinationBytes)) throw new Error(`Refusing to clobber existing output: ${destination}`);
		await fs.rm(temporary);
		return "identical";
	}
}

async function copyVerifiedItem(
	item: InventoryItem,
	backupRoot: string,
	readBytes: number,
	signal: AbortSignal | undefined,
): Promise<InventoryItem> {
	if (!item.original?.sha256) return item;
	const destination = path.join(backupRoot, item.rootId, ...item.relativePath.split("/"));
	const relativeDestination = path.relative(path.resolve(backupRoot), path.resolve(destination));
	if (relativeDestination.startsWith("..") || path.isAbsolute(relativeDestination)) throw new Error("Backup path escaped backup root");
	await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
	await assertNoSymlinkPath(backupRoot, path.dirname(destination));
	const existing = await fs.lstat(destination, { bigint: true }).catch(() => undefined);
	if (existing) {
		if (!existing.isFile() || existing.nlink !== 1n) throw new Error(`Unsafe backup collision at ${destination}`);
		const reread = await readStableSnapshot(destination, 0, readBytes, 1, signal);
		if (reread.accounting.sha256 !== item.original.sha256 || reread.accounting.size !== item.original.size) {
			throw new Error(`Backup collision has different content at ${destination}`);
		}
		return {
			...item,
			status: "copied",
			copied: {
				path: destination,
				sha256: reread.accounting.sha256,
				size: reread.accounting.size,
				mode: reread.accounting.mode,
			},
			disposition: { code: "already-copied-identical", reason: "Existing immutable copy is byte-identical", evidence: [] },
		};
	}
	const temporary = `${destination}.partial-${crypto.randomUUID()}`;
	const sourceHandle = await fs.open(item.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	const destinationHandle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	let sourceAfter: BigIntStats | undefined;
	let written = 0n;
	const hasher = createHash("sha256");
	try {
		const sourceBefore = await sourceHandle.stat({ bigint: true });
		if (
			sourceBefore.dev.toString() !== item.original.device ||
			sourceBefore.ino.toString() !== item.original.inode ||
			sourceBefore.size.toString() !== item.original.size ||
			sourceBefore.mtimeNs.toString() !== item.original.modifiedNs ||
			sourceBefore.ctimeNs.toString() !== item.original.changedNs
		) {
			throw new Error("Source changed after inventory and before copy");
		}
		const buffer = Buffer.allocUnsafe(readBytes);
		let position = 0;
		while (true) {
			assertNotAborted(signal);
			const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.byteLength, position);
			if (bytesRead === 0) break;
			const bytes = buffer.subarray(0, bytesRead);
			hasher.update(bytes);
			let offset = 0;
			while (offset < bytesRead) {
				const result = await destinationHandle.write(bytes, offset, bytesRead - offset, Number(written));
				if (result.bytesWritten === 0) throw new Error("Short write while creating immutable copy");
				offset += result.bytesWritten;
				written += BigInt(result.bytesWritten);
			}
			position += bytesRead;
		}
		sourceAfter = await sourceHandle.stat({ bigint: true });
		const sourcePathAfter = await fs.lstat(item.sourcePath, { bigint: true });
		const digest = hasher.digest("hex");
		if (!sameFileState(sourceBefore, sourceAfter) || !sameFileState(sourceAfter, sourcePathAfter)) {
			throw new Error("Source changed during copy");
		}
		if (digest !== item.original.sha256 || written.toString() !== item.original.size) {
			throw new Error("Source bytes no longer match inventoried hash and size");
		}
		await destinationHandle.sync();
	} catch (error) {
		await Promise.allSettled([sourceHandle.close(), destinationHandle.close()]);
		await fs.rm(temporary, { force: true });
		return {
			...item,
			status: "pending",
			disposition: {
				code: "changed-or-copy-failed",
				reason: error instanceof Error ? error.message : String(error),
				evidence: ["No partial copy was published"],
			},
		};
	}
	await sourceHandle.close();
	await destinationHandle.close();
	if (!sourceAfter) throw new Error("Source state unavailable after copy");
	await fs.utimes(temporary, Number(sourceAfter.atimeNs) / 1e9, Number(sourceAfter.mtimeNs) / 1e9).catch(() => undefined);
	const immutableMode = Number(sourceAfter.mode & 0o555n);
	await fs.chmod(temporary, immutableMode);
	const metadataHandle = await fs.open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
	await metadataHandle.sync();
	await metadataHandle.close();
	await assertNoSymlinkPath(backupRoot, path.dirname(destination));
	await publishNoClobber(temporary, destination);
	const copied = await readStableSnapshot(destination, 0, readBytes, 1, signal);
	if (copied.accounting.sha256 !== item.original.sha256 || copied.accounting.size !== item.original.size) {
		return {
			...item,
			status: "quarantined",
			disposition: {
				code: "copy-verification-failed",
				reason: "Published copy did not match inventoried source bytes",
				evidence: [copied.accounting.sha256 ?? "missing destination hash"],
			},
		};
	}
	return {
		...item,
		status: "copied",
		copied: {
			path: destination,
			sha256: copied.accounting.sha256,
			size: copied.accounting.size,
			mode: copied.accounting.mode,
		},
		disposition: {
			code: item.classification.format === "archive" ? "immutable-archive-copy" : "immutable-copy",
			reason:
				item.classification.format === "archive"
					? "Archive copied byte-exactly; members require an explicit later inventory on this copy"
					: "Byte-exact immutable copy verified",
			evidence: [item.original.sha256],
		},
	};
}

function summarize(items: readonly InventoryItem[]): InventorySummary {
	let discoveredBytes = 0n;
	let copiedBytes = 0n;
	for (const item of items) {
		discoveredBytes += BigInt(item.original?.size ?? "0");
		copiedBytes += BigInt(item.copied?.size ?? "0");
	}
	const aggregate = createHash("sha256");
	for (const item of [...items].sort((left, right) => left.itemId.localeCompare(right.itemId, "en"))) {
		aggregate.update(`${item.itemId}\0${item.original?.sha256 ?? "unknown"}\0${item.status}\0${item.disposition?.code ?? "none"}\n`);
	}
	return {
		discovered: items.length,
		accounted: items.filter(item => item.status !== "pending").length,
		copied: items.filter(item => item.status === "copied").length,
		excluded: items.filter(item => item.status === "excluded").length,
		pending: items.filter(item => item.status === "pending").length,
		quarantined: items.filter(item => item.status === "quarantined").length,
		discoveredBytes: discoveredBytes.toString(),
		copiedBytes: copiedBytes.toString(),
		aggregateSha256: aggregate.digest("hex"),
	};
}

/** Inventory and immutably copy only regular, non-secret, non-executable files from explicit roots. */
export async function inventoryAndCopy(options: InventoryOptions): Promise<InventoryManifest> {
	if (options.roots.length === 0) throw new Error("At least one caller-designated source root is required");
	if (!path.isAbsolute(options.backupRoot)) throw new Error("backupRoot must be absolute");
	const rootIds = new Set<string>();
	for (const root of options.roots) {
		if (!path.isAbsolute(root.path)) throw new Error(`Source root must be absolute: ${root.path}`);
		if (rootIds.has(root.rootId)) throw new Error(`Duplicate rootId: ${root.rootId}`);
		rootIds.add(root.rootId);
		stableSourceNamespace(root);
	}
	const snapshotAt = options.snapshotAt ?? new Date().toISOString();
	if (!Number.isFinite(Date.parse(snapshotAt))) throw new Error("snapshotAt must be an ISO timestamp");
	const sniffBytes = Math.max(4 * 1024, options.sniffBytes ?? DEFAULT_SNIFF_BYTES);
	const readBytes = Math.max(4 * 1024, options.readBytes ?? DEFAULT_READ_BYTES);
	const maxAttempts = Math.max(1, options.maxReadAttempts ?? DEFAULT_ATTEMPTS);
	const maxDepth = Math.max(1, options.maxDepth ?? 64);
	const maxItems = Math.max(1, options.maxItems ?? 10_000_000);
	const provisional: InventoryItem[] = [];
	for (const root of options.roots) {
		for await (const discovered of walkRoot(root, maxDepth)) {
			if (provisional.length >= maxItems) {
				throw new Error(`Discovered item count exceeds configured limit ${maxItems}`);
			}
			assertNotAborted(options.signal);
			if (discovered.kind !== "file") {
				const item = pendingItem(discovered, snapshotAt, discovered.discoveryError ?? discovered.kind);
				provisional.push({
					...item,
					status: "excluded",
					disposition: exclusionFor(discovered, item.classification, undefined, new Uint8Array()),
				});
				continue;
			}
			try {
				const snapshot = await readStableSnapshot(
					discovered.sourcePath,
					sniffBytes,
					readBytes,
					maxAttempts,
					options.signal,
					options.onReadProgress,
				);
				const classification = classifySourceContent(snapshot.prefix, snapshot.prefixIsComplete);
				const exclusion = exclusionFor(discovered, classification, snapshot.accounting, snapshot.prefix);
				const changed = snapshot.accounting.changedDuringRead;
				provisional.push({
					schemaVersion: INVENTORY_SCHEMA_VERSION,
					itemId: itemId(discovered.sourceNamespace, root.rootId, discovered.relativePath),
					rootId: root.rootId,
					sourceNamespace: discovered.sourceNamespace,
					sourcePath: discovered.sourcePath,
					relativePath: discovered.relativePath,
					kind: "file",
					classification,
					original: snapshot.accounting,
					snapshotAt,
					status: changed ? "pending" : exclusion ? "excluded" : "pending",
					disposition: changed
						? {
								code: "changed-during-read",
								reason: `Source changed during all ${snapshot.accounting.readAttempts} read attempts`,
								evidence: [snapshot.accounting.sha256 ?? "hash unavailable"],
							}
						: exclusion,
					metadataObservations: extractedMetadata(
						snapshot.prefix,
						classification,
						snapshotAt,
						discovered.relativePath,
					),
				});
			} catch (error) {
				provisional.push(
					pendingItem(discovered, snapshotAt, error instanceof Error ? error.message : String(error)),
				);
			}
		}
	}
	const copyBytes = provisional
		.filter(item => item.status === "pending" && item.original?.sha256 && !item.original.changedDuringRead)
		.reduce((total, item) => total + BigInt(item.original?.size ?? "0"), 0n);
	const expansionFactor = Math.max(1, Math.ceil(options.expansionFactor ?? 3));
	const reserveBytes = options.reserveBytes ?? 64n * 1024n * 1024n;
	let filesystemPath = path.resolve(options.backupRoot);
	while (!(await fs.lstat(filesystemPath).catch(() => undefined))) {
		const parent = path.dirname(filesystemPath);
		if (parent === filesystemPath) throw new Error(`No existing ancestor for backup root: ${options.backupRoot}`);
		filesystemPath = parent;
	}
	const filesystem = await fs.statfs(filesystemPath, { bigint: true });
	const availableBytes = filesystem.bavail * filesystem.bsize;
	const requiredBytes = copyBytes * BigInt(expansionFactor) + reserveBytes;
	const preflight: InventoryPreflight = {
		ok: availableBytes >= requiredBytes,
		filesystemPath,
		availableBytes: availableBytes.toString(),
		requiredBytes: requiredBytes.toString(),
		copyBytes: copyBytes.toString(),
		expansionFactor,
		reserveBytes: reserveBytes.toString(),
	};
	let items = provisional;
	if (preflight.ok) {
		await fs.mkdir(options.backupRoot, { recursive: true, mode: 0o700 });
		const copied: InventoryItem[] = [];
		for (const item of provisional) {
			assertNotAborted(options.signal);
			if (item.status === "pending" && item.original?.sha256 && !item.original.changedDuringRead) {
				copied.push(await copyVerifiedItem(item, options.backupRoot, readBytes, options.signal));
			} else {
				copied.push(item);
			}
		}
		items = copied;
	} else {
		items = provisional.map(item =>
			item.status === "pending" && item.original?.sha256 && !item.original.changedDuringRead
				? {
						...item,
						disposition: {
							code: "insufficient-space",
							reason: "Free-space preflight failed before any source copy",
							evidence: [`required=${requiredBytes}`, `available=${availableBytes}`],
						},
					}
				: item,
		);
	}
	items.sort((left, right) => {
		const rootOrder = left.rootId.localeCompare(right.rootId, "en");
		return rootOrder === 0 ? left.relativePath.localeCompare(right.relativePath, "en") : rootOrder;
	});
	return {
		schemaVersion: INVENTORY_SCHEMA_VERSION,
		snapshotAt,
		roots: options.roots.map(root => ({
			rootId: root.rootId,
			sourceNamespace: stableSourceNamespace(root),
			runtime: root.runtime,
		})),
		backupRoot: options.backupRoot,
		preflight,
		items,
		summary: summarize(items),
	};
}

function safeLedgerItem(item: InventoryItem): InventoryItem {
	return {
		...item,
		sourcePath: `${item.rootId}:${item.relativePath}`,
		copied: item.copied
			? { ...item.copied, path: `backup:${item.rootId}/${item.relativePath}` }
			: undefined,
	};
}

async function publishFile(filePath: string, write: (handle: fs.FileHandle) => Promise<void>): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const parentStats = await fs.lstat(path.dirname(filePath));
	if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) throw new Error("Unsafe manifest output directory");
	const temporary = `${filePath}.partial-${crypto.randomUUID()}`;
	const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		await write(handle);
		await handle.sync();
	} catch (error) {
		await handle.close();
		await fs.rm(temporary, { force: true });
		throw error;
	}
	await handle.close();
	await publishNoClobber(temporary, filePath);
}

/** Atomically publish a path-redacted JSONL ledger and summary outside the database. */
export async function writeInventoryOutputs(manifest: InventoryManifest, outputDirectory: string): Promise<{
	readonly ledgerPath: string;
	readonly manifestPath: string;
}> {
	if (!path.isAbsolute(outputDirectory)) throw new Error("outputDirectory must be absolute");
	const ledgerPath = path.join(outputDirectory, "source-ledger.jsonl");
	const manifestPath = path.join(outputDirectory, "manifest.json");
	await publishFile(ledgerPath, async handle => {
		for (const item of manifest.items) await handle.write(`${JSON.stringify(safeLedgerItem(item))}\n`);
	});
	const safeManifest = {
		schemaVersion: manifest.schemaVersion,
		snapshotAt: manifest.snapshotAt,
		roots: manifest.roots,
		backupRoot: "caller-owned-backup",
		preflight: { ...manifest.preflight, filesystemPath: "caller-owned-backup" },
		summary: manifest.summary,
	};
	await publishFile(manifestPath, async handle => {
		await handle.write(`${JSON.stringify(safeManifest, null, 2)}\n`);
	});
	return { ledgerPath, manifestPath };
}
