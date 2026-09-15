import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
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

export async function verifyPublishedBundle(path: string): Promise<PublishedBundle & { bundle: LogicalBundle }> {
	const root = resolve(path);
	const stat = await lstat(root);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Bundle path is not a real directory: ${root}`);
	const manifestBytes = await readFile(join(root, MANIFEST_FILE_NAME), "utf8");
	const manifest = JSON.parse(manifestBytes) as BundleManifest;
	if (manifest.format !== BUNDLE_MANIFEST_FORMAT) throw new Error(`Unsupported manifest format: ${manifest.format}`);
	const manifestSha256 = sha256(manifestBytes);
	const marker = await readFile(join(root, COMPLETION_MARKER_NAME), "utf8");
	if (marker !== `${manifestSha256}\n`) throw new Error("Completion marker does not match manifest");
	const allowed = new Set([MANIFEST_FILE_NAME, COMPLETION_MARKER_NAME]);
	for (const file of manifest.files) {
		assertSafeRelativePath(file.path);
		if (allowed.has(file.path)) throw new Error(`Manifest reserves path ${file.path}`);
		allowed.add(file.path);
		const fullPath = join(root, file.path);
		const entryStat = await lstat(fullPath);
		if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error(`Manifest entry is not a regular file: ${file.path}`);
		const bytes = await readFile(fullPath);
		if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
			throw new Error(`Manifest verification failed for ${file.path}`);
		}
	}
	const actualFiles = await listFiles(root);
	for (const file of actualFiles) {
		if (!allowed.has(file)) throw new Error(`Unmanifested file in bundle: ${file}`);
	}
	if (!allowed.has(BUNDLE_FILE_NAME)) throw new Error("Manifest omits logical bundle");
	const bundleBytes = await readFile(join(root, BUNDLE_FILE_NAME), "utf8");
	if (sha256(bundleBytes) !== manifest.bundle_sha256) throw new Error("Logical bundle checksum mismatch");
	const bundle = JSON.parse(bundleBytes) as LogicalBundle;
	assertLogicalBundle(bundle);
	return { path: root, manifest, manifestSha256, bundle };
}

function assertSafeRelativePath(path: string): void {
	if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
		throw new Error(`Unsafe manifest path: ${path}`);
	}
}

async function listFiles(root: string, current = root): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(current, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) throw new Error(`Symlink is forbidden in bundle: ${entry.name}`);
		const fullPath = join(current, entry.name);
		if (entry.isDirectory()) result.push(...(await listFiles(root, fullPath)));
		else if (entry.isFile()) result.push(relative(root, fullPath).split(sep).join("/"));
		else throw new Error(`Unsupported filesystem entry in bundle: ${entry.name}`);
	}
	return result;
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
