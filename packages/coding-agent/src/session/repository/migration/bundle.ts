import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	rm,
	type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const LOGICAL_BUNDLE_FORMAT = "omp-logical-bundle-v1";
export const BUNDLE_MANIFEST_FORMAT = "omp-logical-bundle-manifest-v1";
export const BUNDLE_FILE_NAME = "bundle.json";
export const MANIFEST_FILE_NAME = "manifest.json";
export const COMPLETION_MARKER_NAME = "COMPLETE";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

/** Slice-local wire shape. The repository barrel adapts this to SessionImportItem/SessionExportItem. */
export interface LogicalEvent {
	event_hash: string;
	origin_id: string;
	parent_hash: string | null;
	native_entry_id: string | null;
	kind: string;
	timestamp: string;
	payload_hash: string;
	payload: JsonValue;
}

export interface LogicalVersion {
	version_id: string;
	origin_id: string;
	branch_id: string;
	parent_version_id: string | null;
	head_hash: string | null;
	fork_point_hash: string | null;
	metadata_revision_id: string;
	metadata: JsonValue;
}

export interface LogicalBranch {
	branch_id: string;
	origin_id: string;
	parent_branch_id: string | null;
	fork_point_hash: string | null;
	head_hash: string | null;
	head_version_id: string;
	/** Durable source identities that prevent an imported branch from echoing back as a new fork. */
	replica_aliases?: readonly { replica_id: string; branch_id: string }[];
}

export interface LogicalBundle {
	format: typeof LOGICAL_BUNDLE_FORMAT;
	replica_id: string;
	origins: readonly string[];
	events: readonly LogicalEvent[];
	versions: readonly LogicalVersion[];
	branches: readonly LogicalBranch[];
}

export interface ManifestFile {
	path: string;
	bytes: number;
	sha256: string;
}

export interface BundleManifest {
	format: typeof BUNDLE_MANIFEST_FORMAT;
	generation_id: string;
	bundle_sha256: string;
	files: readonly ManifestFile[];
}

export interface PublishedBundle {
	path: string;
	manifest: BundleManifest;
	manifestSha256: string;
}

export interface PublishBundleOptions {
	/** Existing real directory containing destination; traversal and symlinks are rejected. */
	allowedRoot: string;
	destination: string;
	generationId: string;
	validate?: (bundle: LogicalBundle) => void | Promise<void>;
	/** Fault hook used only by scoped crash-recovery tests. */
	beforePublish?: (stagingPath: string, manifest: BundleManifest) => void | Promise<void>;
}

export interface VerifyPublishedBundleOptions {
	/** Existing real directory that authorizes the bundle path. */
	allowedRoot: string;
	/** Fault hook used by scoped path-swap tests after the bundle descriptor is retained. */
	afterDirectoryOpen?: () => void | Promise<void>;
}

export interface ArchiveStreamLimits {
	maxEntryBytes: number;
	maxEntriesPerPage: number;
	maxTotalEntries: number;
	maxTotalEntryBytes: number;
	maxPayloadRefsPerPage: number;
	maxTotalPayloadRefs: number;
}

export interface ArchiveEntryPage<T> {
	items: readonly T[];
	byteLength: number;
}

export interface ArchivePayloadPage<T> {
	items: readonly T[];
}

export interface BoundedArchiveStream<E, P> {
	entryCount: number;
	entryBytes: number;
	payloadRefCount: number;
	openEntryPages(): AsyncIterable<ArchiveEntryPage<E>>;
	openPayloadPages(): AsyncIterable<ArchivePayloadPage<P>>;
}

export interface ArchiveStreamConsumer<E, P> {
	measureEntry(entry: E): number;
	consumeEntryPage(page: ArchiveEntryPage<E>): Promise<void>;
	consumePayloadPage(page: ArchivePayloadPage<P>): Promise<void>;
}

export interface EncodedArchiveEntry {
	encodedByteLength: number;
}

export interface SessionArchiveStreamConsumer<E extends EncodedArchiveEntry, P> {
	consumeEntryPage(page: ArchiveEntryPage<E>): Promise<void>;
	consumePayloadPage(page: ArchivePayloadPage<P>): Promise<void>;
}

export interface ArchiveStreamReceipt {
	entryCount: number;
	entryBytes: number;
	payloadRefs: number;
}

export function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value: JsonValue | LogicalBundle | BundleManifest): string {
	return canonicalize(value, new Set<object>());
}

function canonicalize(value: unknown, seen: Set<object>): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new TypeError("Canonical JSON cannot encode cycles");
		seen.add(value);
		const encoded = `[${value.map((entry) => canonicalize(entry, seen)).join(",")}]`;
		seen.delete(value);
		return encoded;
	}
	if (typeof value === "object") {
		if (seen.has(value)) throw new TypeError("Canonical JSON cannot encode cycles");
		seen.add(value);
		const record = value as Record<string, unknown>;
		const fields = Object.keys(record)
			.sort()
			.map((key) => {
				const field = record[key];
				if (field === undefined) throw new TypeError(`Canonical JSON cannot encode undefined field ${key}`);
				return `${JSON.stringify(key)}:${canonicalize(field, seen)}`;
			});
		seen.delete(value);
		return `{${fields.join(",")}}`;
	}
	throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

export function assertLogicalBundle(bundle: LogicalBundle): void {
	if (bundle.format !== LOGICAL_BUNDLE_FORMAT) throw new Error(`Unsupported bundle format: ${bundle.format}`);
	if (!bundle.replica_id) throw new Error("Bundle replica_id is required");
	const originIds = new Set(bundle.origins);
	const eventHashes = new Set<string>();
	for (const event of bundle.events) {
		if (!originIds.has(event.origin_id)) throw new Error(`Event ${event.event_hash} references missing origin`);
		if (eventHashes.has(event.event_hash)) throw new Error(`Duplicate event hash ${event.event_hash}`);
		if (sha256(canonicalJson(event.payload)) !== event.payload_hash) {
			throw new Error(`Payload checksum mismatch for event ${event.event_hash}`);
		}
		eventHashes.add(event.event_hash);
	}
	for (const event of bundle.events) {
		if (event.parent_hash !== null && !eventHashes.has(event.parent_hash)) {
			throw new Error(`Event ${event.event_hash} references missing parent ${event.parent_hash}`);
		}
	}
	const versionIds = new Set<string>();
	for (const version of bundle.versions) {
		if (versionIds.has(version.version_id)) throw new Error(`Duplicate version ${version.version_id}`);
		if (!originIds.has(version.origin_id)) throw new Error(`Version ${version.version_id} references missing origin`);
		if (version.head_hash !== null && !eventHashes.has(version.head_hash)) {
			throw new Error(`Version ${version.version_id} references missing head ${version.head_hash}`);
		}
		versionIds.add(version.version_id);
	}
	for (const version of bundle.versions) {
		if (version.parent_version_id !== null && !versionIds.has(version.parent_version_id)) {
			throw new Error(`Version ${version.version_id} references missing predecessor ${version.parent_version_id}`);
		}
	}
	const branchIds = new Set<string>();
	for (const branch of bundle.branches) {
		if (branchIds.has(branch.branch_id)) throw new Error(`Duplicate branch ${branch.branch_id}`);
		if (!originIds.has(branch.origin_id)) throw new Error(`Branch ${branch.branch_id} references missing origin`);
		if (!versionIds.has(branch.head_version_id)) throw new Error(`Branch ${branch.branch_id} references missing version`);
		branchIds.add(branch.branch_id);
	}
}

export async function consumeBoundedArchiveStream<E, P>(
	stream: BoundedArchiveStream<E, P>,
	limits: ArchiveStreamLimits,
	consumer: ArchiveStreamConsumer<E, P>,
): Promise<ArchiveStreamReceipt> {
	assertArchiveLimits(limits);
	let entryCount = 0;
	let entryBytes = 0;
	for await (const page of stream.openEntryPages()) {
		if (page.items.length === 0 || page.items.length > limits.maxEntriesPerPage) {
			throw new Error("Archive entry page violates its item bound");
		}
		let measuredPageBytes = 0;
		for (const entry of page.items) {
			const bytes = consumer.measureEntry(entry);
			assertMeasuredRecord(bytes, limits.maxEntryBytes, "entry");
			measuredPageBytes += bytes;
		}
		if (page.byteLength !== measuredPageBytes) throw new Error("Archive entry page byteLength is not exact");
		entryBytes += measuredPageBytes;
		entryCount += page.items.length;
		if (entryCount > limits.maxTotalEntries) throw new Error("Archive item exceeds its total entry count limit");
		if (entryBytes > limits.maxTotalEntryBytes) throw new Error("Archive item exceeds its total entry byte limit");
		if (entryCount > stream.entryCount) throw new Error("Archive stream exceeds its declared entry count");
		await consumer.consumeEntryPage(page);
	}
	if (entryCount !== stream.entryCount || entryBytes !== stream.entryBytes) {
		throw new Error("Archive stream totals do not match its declared count and bytes");
	}
	let payloadRefs = 0;
	for await (const page of stream.openPayloadPages()) {
		if (page.items.length === 0 || page.items.length > limits.maxPayloadRefsPerPage) {
			throw new Error("Archive payload page violates its item bound");
		}
		payloadRefs += page.items.length;
		if (payloadRefs > limits.maxTotalPayloadRefs || payloadRefs > stream.payloadRefCount) {
			throw new Error("Archive item exceeds its total payload reference limit");
		}
		await consumer.consumePayloadPage(page);
	}
	if (payloadRefs !== stream.payloadRefCount) {
		throw new Error("Archive stream payload count does not match its declaration");
	}
	return { entryCount, entryBytes, payloadRefs };
}

/**
 * Direct adapter for the authoritative SessionArchiveItem page shape. Pages
 * remain reusable and are consumed sequentially with byte backpressure.
 */
export function consumeSessionArchiveItemStream<E extends EncodedArchiveEntry, P>(
	stream: BoundedArchiveStream<E, P>,
	limits: ArchiveStreamLimits,
	consumer: SessionArchiveStreamConsumer<E, P>,
): Promise<ArchiveStreamReceipt> {
	return consumeBoundedArchiveStream(stream, limits, {
		measureEntry: (record) => record.encodedByteLength,
		consumeEntryPage: consumer.consumeEntryPage,
		consumePayloadPage: consumer.consumePayloadPage,
	});
}

function assertArchiveLimits(limits: ArchiveStreamLimits): void {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid archive stream limit ${name}`);
	}
}

function assertMeasuredRecord(bytes: number, limit: number, kind: string): void {
	if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Invalid ${kind} byte length`);
	if (bytes > limit) throw new Error(`Archive ${kind} exceeds its record byte limit`);
}

export async function publishLogicalBundle(bundle: LogicalBundle, options: PublishBundleOptions): Promise<PublishedBundle> {
	assertLogicalBundle(bundle);
	await options.validate?.(bundle);
	const destination = await assertContainedPublicationPath(options.allowedRoot, options.destination);
	const parent = dirname(destination);
	await assertAbsent(destination);
	const staging = join(parent, `.${basename(destination)}.${options.generationId}.partial`);
	await assertAbsent(staging);
	await mkdir(staging, { recursive: false });
	let renamed = false;
	try {
		const bundleBytes = canonicalJson(bundle);
		await durableWrite(join(staging, BUNDLE_FILE_NAME), bundleBytes);
		const manifest: BundleManifest = {
			format: BUNDLE_MANIFEST_FORMAT,
			generation_id: options.generationId,
			bundle_sha256: sha256(bundleBytes),
			files: [{ path: BUNDLE_FILE_NAME, bytes: Buffer.byteLength(bundleBytes), sha256: sha256(bundleBytes) }],
		};
		const manifestBytes = canonicalJson(manifest);
		await durableWrite(join(staging, MANIFEST_FILE_NAME), manifestBytes);
		const manifestSha256 = sha256(manifestBytes);
		await durableWrite(join(staging, COMPLETION_MARKER_NAME), `${manifestSha256}\n`);
		await fsyncDirectory(staging);
		await options.beforePublish?.(staging, manifest);
		await rename(staging, destination);
		renamed = true;
		await fsyncDirectory(parent);
		return { path: destination, manifest, manifestSha256 };
	} finally {
		if (!renamed) await rm(staging, { recursive: true, force: true });
	}
}

export async function verifyPublishedBundle(
	path: string,
	options: VerifyPublishedBundleOptions,
): Promise<PublishedBundle & { bundle: LogicalBundle }> {
	const root = resolve(path);
	const directory = await openDirectoryBeneath(options.allowedRoot, root);
	try {
		const directoryBefore = await directory.stat({ bigint: true });
		await options.afterDirectoryOpen?.();
		const manifestBytes = await readStableRegularFileAt(directory, MANIFEST_FILE_NAME);
		const manifestText = manifestBytes.toString("utf8");
		const manifest = JSON.parse(manifestText) as BundleManifest;
		if (manifest.format !== BUNDLE_MANIFEST_FORMAT) throw new Error(`Unsupported manifest format: ${manifest.format}`);
		const manifestSha256 = sha256(manifestBytes);
		const marker = await readStableRegularFileAt(directory, COMPLETION_MARKER_NAME);
		if (marker.toString("utf8") !== `${manifestSha256}\n`) throw new Error("Completion marker does not match manifest");
		const allowed = new Set([MANIFEST_FILE_NAME, COMPLETION_MARKER_NAME]);
		let bundleBytes: Buffer | undefined;
		for (const file of manifest.files) {
			assertSafeRelativePath(file.path);
			if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error(`Invalid manifest byte count: ${file.path}`);
			if (allowed.has(file.path)) throw new Error(`Duplicate or reserved manifest path ${file.path}`);
			allowed.add(file.path);
			const bytes = await readStableRegularFileAt(directory, file.path);
			if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
				throw new Error(`Manifest verification failed for ${file.path}`);
			}
			if (file.path === BUNDLE_FILE_NAME) bundleBytes = bytes;
		}
		const entries = await readdir(descriptorPath(directory), { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !allowed.has(entry.name)) {
				throw new Error(`Unsupported or unmanifested entry in bundle: ${entry.name}`);
			}
		}
		if (!bundleBytes) throw new Error("Manifest omits logical bundle");
		const reopened = await openDirectoryBeneath(options.allowedRoot, root);
		try {
			const reopenedStat = await reopened.stat({ bigint: true });
			if (directoryBefore.dev !== reopenedStat.dev || directoryBefore.ino !== reopenedStat.ino) {
				throw new Error("Bundle path was replaced during verification");
			}
		} finally {
			await reopened.close();
		}
		if (sha256(bundleBytes) !== manifest.bundle_sha256) throw new Error("Logical bundle checksum mismatch");
		const directoryAfter = await directory.stat({ bigint: true });
		if (!sameStableInode(directoryBefore, directoryAfter)) throw new Error("Bundle directory changed during verification");
		const bundle = JSON.parse(bundleBytes.toString("utf8")) as LogicalBundle;
		assertLogicalBundle(bundle);
		return { path: root, manifest, manifestSha256, bundle };
	} finally {
		await directory.close();
	}
}

function assertSafeRelativePath(path: string): void {
	if (!path || path.includes("/") || path.includes("\\") || path.includes("\0") || path === "." || path === "..") {
		throw new Error(`Unsafe manifest path: ${path}`);
	}
}

async function openDirectoryBeneath(root: string, candidate: string): Promise<FileHandle> {
	const absoluteRoot = resolve(root);
	const absoluteCandidate = resolve(candidate);
	const rel = relative(absoluteRoot, absoluteCandidate);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Bundle path escapes or equals its allowed root");
	}
	let current = await open(
		absoluteRoot,
		constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		const rootStat = await current.stat();
		if (!rootStat.isDirectory()) throw new Error("Bundle root descriptor is not a directory");
		for (const component of rel.split(sep)) {
			assertSafeRelativePath(component);
			const next = await open(
				`${descriptorPath(current)}/${component}`,
				constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
			);
			const nextStat = await next.stat();
			if (!nextStat.isDirectory()) {
				await next.close();
				throw new Error(`Bundle path component is not a directory: ${component}`);
			}
			await current.close();
			current = next;
		}
		return current;
	} catch (error) {
		await current.close().catch(() => undefined);
		throw error;
	}
}

async function readStableRegularFileAt(directory: FileHandle, name: string): Promise<Buffer> {
	assertSafeRelativePath(name);
	const file = await open(`${descriptorPath(directory)}/${name}`, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = await file.stat({ bigint: true });
		if (!before.isFile()) throw new Error(`Bundle entry is not a regular file: ${name}`);
		const bytes = await file.readFile();
		const after = await file.stat({ bigint: true });
		if (!sameStableInode(before, after) || after.size !== BigInt(bytes.byteLength)) {
			throw new Error(`Bundle entry changed during verification: ${name}`);
		}
		return bytes;
	} finally {
		await file.close();
	}
}

function sameStableInode(left: BigIntStats, right: BigIntStats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function descriptorPath(handle: FileHandle): string {
	return `/proc/self/fd/${handle.fd}`;
}

async function durableWrite(path: string, bytes: string | Uint8Array): Promise<void> {
	const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		await file.writeFile(bytes);
		await file.sync();
	} finally {
		await file.close();
	}
}

async function assertContainedPublicationPath(root: string, destination: string): Promise<string> {
	const absoluteRoot = resolve(root);
	const absoluteDestination = resolve(destination);
	const rel = relative(absoluteRoot, absoluteDestination);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Publication destination escapes or equals its allowed root");
	}
	const rootStat = await lstat(absoluteRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (await realpath(absoluteRoot)) !== absoluteRoot) {
		throw new Error("Publication root must be a real, non-symlink directory");
	}
	let cursor = absoluteRoot;
	const parts = rel.split(sep);
	for (let index = 0; index < parts.length - 1; index += 1) {
		cursor = join(cursor, parts[index]);
		const stat = await lstat(cursor);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe publication path component: ${cursor}`);
	}
	return absoluteDestination;
}

async function fsyncDirectory(path: string): Promise<void> {
	const directory = await open(path, constants.O_RDONLY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

async function assertAbsent(path: string): Promise<void> {
	try {
		await access(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error(`Refusing to replace existing path: ${path}`);
}
