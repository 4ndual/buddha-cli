import * as fs from "node:fs/promises";
import * as path from "node:path";

export type RootPolicy = "session-tree" | "attachment-tree" | "manifest-tree" | "archive-tree";
export type Disposition = "copied" | "excluded" | "pending" | "quarantined";
export type ProvenanceStatus = "source-recorded" | "externally-recorded" | "inferred" | "unknown";

export interface InventoryRoot {
	name: string;
	harness: string;
	namespace: string;
	path: string;
	policy: RootPolicy;
	runtimeVersion?: string;
}

export interface MetadataObservation {
	field: string;
	value: string | number | boolean | null;
	status: ProvenanceStatus;
	source: string;
	acquiredAt: string;
}

export interface InventoryRecord {
	sourcePath: string;
	relativePath: string;
	rootName: string;
	sourceRoot: string;
	harness: string;
	namespace: string;
	format: string;
	size: number;
	atime: string;
	mtime: string;
	ctime: string;
	birthtime: string | null;
	permissions: string;
	sha256Before: string | null;
	sha256After: string | null;
	copySha256: string | null;
	copyPath: string | null;
	disposition: Disposition;
	reason: string;
	attempts: number;
	observations: MetadataObservation[];
}

export interface PressureObservation {
	source: "/proc/pressure/io";
	observedAt: string;
	raw: string | null;
}

export interface InventoryReport {
	schema: "omp.wcdb.inventory.v1";
	toolVersion: "1";
	snapshotAt: string;
	since: string;
	mode: "plan" | "copy";
	destination: string;
	roots: InventoryRoot[];
	preflight: {
		requiredBytes: number;
		existingCopyBytes: number;
		remainingCopyBytes: number;
		freeBytes: number;
		copyBudgetBytes: number;
		sufficient: boolean;
		formula: { originals: number; normalized: number; stagingDb: number; indexes: number; wal: number; temporaryExport: number };
		ioPressure: PressureObservation[];
	};
	totals: { records: number; bytes: number; byDisposition: Record<Disposition, { records: number; bytes: number }>; byHarness: Record<string, { records: number; bytes: number }> };
	adapterMatrix: Array<{ harness: string; format: string; records: number; bytes: number; adapter: string; capability: "supported" | "pending" | "quarantined" }>;
	records: InventoryRecord[];
	noProductionMutation: { sourceWrites: 0; sourceDeletes: 0; sourcePermissionChanges: 0; destinationOnlyWrites: true; originalsStable: boolean };
}

export interface InventoryOptions {
	roots: InventoryRoot[];
	destination: string;
	since: Date;
	mode: "plan" | "copy";
	copyBudgetBytes?: number;
	retries?: number;
	now?: () => Date;
	afterCopyAttempt?: (sourcePath: string, attempt: number) => void | Promise<void>;
}

const SECRET_COMPONENT = /(^|[._-])(auth|credential|credentials|env|oauth|token|secret|password|passwd|key|private[-_]?key|api[-_]?key|bws)([._-]|$)/i;
const TEMP_SUFFIX = ".partial-wcdb-inventory";
const PREFIX_BYTES = 256 * 1024;

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function isInside(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function canonicalExisting(input: string): Promise<string> {
	let cursor = path.resolve(input);
	const suffix: string[] = [];
	for (;;) {
		try {
			const real = await fs.realpath(cursor);
			return path.join(real, ...suffix.reverse());
		} catch (error) {
			if (!isMissing(error)) throw error;
			const parent = path.dirname(cursor);
			if (parent === cursor) throw error;
			suffix.push(path.basename(cursor));
			cursor = parent;
		}
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isMissing(error: unknown): boolean {
	return hasErrorCode(error, "ENOENT");
}

export async function assertSafeDestination(destination: string, roots: readonly InventoryRoot[]): Promise<string> {
	const canonicalDestination = await canonicalExisting(destination);
	for (const root of roots) {
		const rootStat = await fs.lstat(root.path);
		if (rootStat.isSymbolicLink()) throw new Error(`Source root is a symbolic link: ${root.path}`);
		const canonicalRoot = await fs.realpath(root.path);
		if (isInside(canonicalDestination, canonicalRoot)) {
			throw new Error(`Destination must not be inside source root ${root.name}`);
		}
	}
	return canonicalDestination;
}

export async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

interface Classified {
	format: string;
	copy: boolean;
	reason: string;
	observations: Array<{ field: string; value: string | number | boolean | null; status: ProvenanceStatus; source: string }>;
	corrupt?: boolean;
}

function safeScalar(value: unknown): string | number | boolean | null | undefined {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	return undefined;
}

function observe(target: Classified["observations"], field: string, value: unknown, source: string, status: ProvenanceStatus = "source-recorded"): void {
	const scalar = safeScalar(value);
	if (scalar !== undefined) target.push({ field, value: scalar, source, status });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function classifyJson(value: unknown, source: string): Classified | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const observations: Classified["observations"] = [];
	if (record.type === "session" && typeof record.id === "string") {
		observe(observations, "nativeSessionId", record.id, source);
		if (typeof record.version === "number") observe(observations, "schemaVersion", record.version, source);
		else observe(observations, "schemaVersion", 1, source, "inferred");
		observe(observations, "cwd", record.cwd, source);
		observe(observations, "createdAt", record.timestamp, source);
		observe(observations, "gitBranch", record.gitBranch, source);
		return { format: "omp-jsonl", copy: true, reason: typeof record.version === "number" ? "recognized-session-header" : "recognized-legacy-v1-session-header", observations };
	}
	if (record.type === "session_meta") {
		const payload = asRecord(record.payload);
		if (payload) {
			observe(observations, "nativeSessionId", payload.id, source);
			observe(observations, "cwd", payload.cwd, source);
			observe(observations, "runtimeVersion", payload.cli_version, source);
			observe(observations, "origin", payload.origin, source);
		}
		observe(observations, "createdAt", record.timestamp, source);
		return { format: "codex-rollout-jsonl", copy: true, reason: "recognized-session-meta", observations };
	}
	if (typeof record.sessionId === "string" && typeof record.type === "string") {
		observe(observations, "nativeSessionId", record.sessionId, source);
		observe(observations, "cwd", record.cwd, source);
		observe(observations, "gitBranch", record.gitBranch, source);
		observe(observations, "runtimeVersion", record.version, source);
		return { format: "claude-code-jsonl", copy: true, reason: "recognized-session-record", observations };
	}
	if (Array.isArray(record.messages) && typeof record.id === "string") {
		observe(observations, "nativeSessionId", record.id, source);
		observe(observations, "cwd", record.working_dir, source);
		observe(observations, "model", record.model, source);
		observe(observations, "provider", record.provider_key, source);
		observe(observations, "createdAt", record.created_at, source);
		return { format: "jcode-session-json", copy: true, reason: "recognized-session-object", observations };
	}
	if (Array.isArray(record.files) && typeof record.source === "string") {
		observe(observations, "manifestSource", record.source, source);
		observe(observations, "createdAt", record.createdAt, source);
		return { format: "session-archive-manifest-json", copy: true, reason: "recognized-session-manifest", observations };
	}
	return undefined;
}

async function classifyFile(filePath: string, relativePath: string, root: InventoryRoot, size: number): Promise<Classified> {
	const components = filePath.split(path.sep);
	if (components.some(component => SECRET_COMPONENT.test(component))) {
		return { format: "secret-bearing-path", copy: false, reason: "excluded-secret-path", observations: [] };
	}
	if (/(?:-wal|-shm)$/u.test(relativePath)) {
		return { format: "sqlite-auxiliary", copy: false, reason: "active-database-auxiliary-requires-supported-snapshot", observations: [] };
	}
	if (root.policy === "attachment-tree") return { format: `${root.harness}-attachment`, copy: true, reason: "declared-attachment-root", observations: [] };
	const prefixBytes = new Uint8Array(await Bun.file(filePath).slice(0, Math.min(size, PREFIX_BYTES)).arrayBuffer());
	const sqliteMagic = new TextDecoder().decode(prefixBytes.slice(0, 16));
	if (sqliteMagic === "SQLite format 3\u0000") {
		return { format: "sqlite", copy: false, reason: "live-or-opaque-database-requires-supported-snapshot", observations: [] };
	}
	const text = new TextDecoder("utf-8", { fatal: false }).decode(prefixBytes);
	const firstLine = text.split(/\r?\n/u).find(line => line.trim().length > 0);
	if (firstLine) {
		try {
			const classified = classifyJson(JSON.parse(firstLine), `${filePath}:first-record`);
			if (classified) return classified;
		} catch {
			if (root.policy === "session-tree" && relativePath.endsWith(".jsonl")) {
				return { format: "malformed-json-session-candidate", copy: true, reason: "invalid-first-json-record", observations: [], corrupt: true };
			}
		}
	}
	if (size <= PREFIX_BYTES && text.trim().length > 0) {
		try {
			const classified = classifyJson(JSON.parse(text), filePath);
			if (classified) return classified;
		} catch {
			// Non-JSON is handled by root policy below.
		}
	}
	if (root.harness === "jcode" && relativePath.endsWith(".json") && /"messages"\s*:/u.test(text) && /"id"\s*:/u.test(text)) {
		return { format: "jcode-session-json", copy: true, reason: "recognized-bounded-session-structure", observations: [] };
	}
	if (root.policy === "manifest-tree") {
		return { format: `${root.harness}-metadata`, copy: true, reason: "declared-metadata-root", observations: [] };
	}
	if (root.policy === "archive-tree" && /\.(?:bundle|zip|tar|tgz|gz|zst)$/iu.test(relativePath)) {
		return { format: "opaque-session-archive", copy: false, reason: "archive-requires-manifest-or-explicit-adapter", observations: [] };
	}
	if (root.policy === "session-tree") {
		return { format: "unknown-session-ancillary", copy: true, reason: "preserved-unknown-record-in-session-tree", observations: [] };
	}
	return { format: "unrecognized", copy: false, reason: "not-session-material", observations: [] };
}

async function* walkFiles(root: string): AsyncGenerator<{ path: string; relative: string }> {
	const rootStat = await fs.lstat(root);
	if (!rootStat.isDirectory()) {
		yield { path: root, relative: path.basename(root) };
		return;
	}
	const queue = [""];
	while (queue.length > 0) {
		const relativeDir = queue.shift()!;
		const directoryPath = path.join(root, relativeDir);
		let entries = await fs.readdir(directoryPath, { withFileTypes: true });
		entries = entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const relative = path.join(relativeDir, entry.name);
			const fullPath = path.join(root, relative);
			if (entry.isSymbolicLink()) {
				yield { path: fullPath, relative };
				continue;
			}
			if (entry.isDirectory()) queue.push(relative);
			else yield { path: fullPath, relative };
		}
	}
}

async function readIoPressure(now: () => Date): Promise<PressureObservation> {
	try {
		return { source: "/proc/pressure/io", observedAt: now().toISOString(), raw: (await Bun.file("/proc/pressure/io").text()).trim() };
	} catch {
		return { source: "/proc/pressure/io", observedAt: now().toISOString(), raw: null };
	}
}

function objectPath(destination: string, hash: string): string {
	return path.join(destination, "objects", "sha256", hash.slice(0, 2), hash);
}

async function measureExistingCopies(destination: string, records: readonly InventoryRecord[]): Promise<number> {
	const sizesByHash = new Map<string, number>();
	for (const record of records) {
		if (!record.sha256Before || (record.disposition !== "pending" && record.disposition !== "quarantined")) continue;
		sizesByHash.set(record.sha256Before, Math.max(sizesByHash.get(record.sha256Before) ?? 0, record.size));
	}
	let bytes = 0;
	for (const [hash, size] of sizesByHash) {
		try {
			const stat = await fs.lstat(objectPath(destination, hash));
			if (stat.isFile() && !stat.isSymbolicLink() && stat.size === size) bytes += size;
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}
	return bytes;
}

export async function copyStableFile(
	sourcePath: string,
	destination: string,
	retries: number,
	afterCopyAttempt?: (sourcePath: string, attempt: number) => void | Promise<void>,
): Promise<{ before: string; after: string; copy: string; copyPath: string; attempts: number } | { before: string; after: string; attempts: number }> {
	let before = "";
	let after = "";
	for (let attempt = 1; attempt <= retries + 1; attempt++) {
		const beforeStat = await fs.stat(sourcePath);
		before = await sha256File(sourcePath);
		const temporary = path.join(destination, `.copy-${process.pid}-${crypto.randomUUID()}${TEMP_SUFFIX}`);
		await Bun.write(temporary, Bun.file(sourcePath));
		if (afterCopyAttempt) await afterCopyAttempt(sourcePath, attempt);
		const copy = await sha256File(temporary);
		after = await sha256File(sourcePath);
		const afterStat = await fs.stat(sourcePath);
		const stable = before === after && before === copy && beforeStat.size === afterStat.size && beforeStat.mtimeMs === afterStat.mtimeMs;
		if (!stable) {
			await fs.rm(temporary, { force: true });
			continue;
		}
		const finalPath = objectPath(destination, before);
		await fs.mkdir(path.dirname(finalPath), { recursive: true });
		try {
			await fs.link(temporary, finalPath);
			await fs.rm(temporary);
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			await fs.rm(temporary, { force: true });
			const existing = await fs.lstat(finalPath);
			if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Existing copy is not a safe regular file: ${finalPath}`);
			if ((await sha256File(finalPath)) !== before) throw new Error(`Existing copy hash mismatch: ${finalPath}`);
		}
		return { before, after, copy, copyPath: finalPath, attempts: attempt };
	}
	return { before, after, attempts: retries + 1 };
}


async function planRecords(options: InventoryOptions, snapshotAt: string): Promise<InventoryRecord[]> {
	const records: InventoryRecord[] = [];
	for (const root of [...options.roots].sort((left, right) => left.name.localeCompare(right.name))) {
		for await (const file of walkFiles(root.path)) {
			const stat = await fs.lstat(file.path);
			if (stat.isSymbolicLink()) {
				records.push({ sourcePath: file.path, relativePath: file.relative, rootName: root.name, sourceRoot: root.path, harness: root.harness, namespace: root.namespace, format: "symbolic-link", size: stat.size, atime: iso(stat.atimeMs), mtime: iso(stat.mtimeMs), ctime: iso(stat.ctimeMs), birthtime: stat.birthtimeMs > 0 ? iso(stat.birthtimeMs) : null, permissions: (stat.mode & 0o7777).toString(8).padStart(4, "0"), sha256Before: null, sha256After: null, copySha256: null, copyPath: null, disposition: "excluded", reason: "unsafe-symbolic-link-not-followed", attempts: 0, observations: [] });
				continue;
			}
			if (!stat.isFile()) continue;
			let classified: Classified;
			try {
				classified = await classifyFile(file.path, file.relative, root, stat.size);
			} catch {
				classified = { format: "unreadable", copy: false, reason: "classification-read-failed", observations: [], corrupt: true };
			}
			const outsideRange = stat.mtimeMs < options.since.getTime();
			const acquiredAt = snapshotAt;
			const observations: MetadataObservation[] = classified.observations.map(observation => ({ ...observation, acquiredAt }));
			if (root.runtimeVersion) observations.push({ field: "runtimeVersion", value: root.runtimeVersion, status: "externally-recorded", source: `root:${root.name}`, acquiredAt });
			let disposition: Disposition = classified.corrupt ? "quarantined" : classified.copy ? "pending" : "excluded";
			let reason = classified.reason;
			if (outsideRange) {
				disposition = "excluded";
				reason = "outside-requested-date-range";
			}
			records.push({ sourcePath: file.path, relativePath: file.relative, rootName: root.name, sourceRoot: root.path, harness: root.harness, namespace: root.namespace, format: classified.format, size: stat.size, atime: iso(stat.atimeMs), mtime: iso(stat.mtimeMs), ctime: iso(stat.ctimeMs), birthtime: stat.birthtimeMs > 0 ? iso(stat.birthtimeMs) : null, permissions: (stat.mode & 0o7777).toString(8).padStart(4, "0"), sha256Before: null, sha256After: null, copySha256: null, copyPath: null, disposition, reason, attempts: 0, observations });
		}
	}
	return records.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function estimate(records: readonly InventoryRecord[]): InventoryReport["preflight"]["formula"] {
	const uniqueSizes = new Map<string, number>();
	for (const record of records) {
		if (record.disposition !== "pending" && record.disposition !== "quarantined") continue;
		const key = record.sha256Before ?? `path:${record.sourcePath}`;
		uniqueSizes.set(key, Math.max(uniqueSizes.get(key) ?? 0, record.size));
	}
	const originals = [...uniqueSizes.values()].reduce((sum, size) => sum + size, 0);
	return {
		originals,
		normalized: Math.ceil(originals * 1.1),
		stagingDb: Math.ceil(originals * 1.25),
		indexes: Math.ceil(originals * 0.35),
		wal: Math.ceil(originals * 0.1),
		temporaryExport: Math.ceil(originals * 1.1),
	};
}

function summarize(records: readonly InventoryRecord[]): Pick<InventoryReport, "totals" | "adapterMatrix"> {
	const byDisposition: InventoryReport["totals"]["byDisposition"] = { copied: { records: 0, bytes: 0 }, excluded: { records: 0, bytes: 0 }, pending: { records: 0, bytes: 0 }, quarantined: { records: 0, bytes: 0 } };
	const byHarness: InventoryReport["totals"]["byHarness"] = {};
	const adapters = new Map<string, { harness: string; format: string; records: number; bytes: number; adapter: string; capability: "supported" | "pending" | "quarantined" }>();
	for (const record of records) {
		byDisposition[record.disposition].records++;
		byDisposition[record.disposition].bytes += record.size;
		const harness = (byHarness[record.harness] ??= { records: 0, bytes: 0 });
		harness.records++;
		harness.bytes += record.size;
		const key = `${record.harness}\u0000${record.format}`;
		const capability = record.disposition === "quarantined" ? "quarantined" : /^(omp-jsonl|claude-code-jsonl|codex-rollout-jsonl|jcode-session-json)$/u.test(record.format) ? "supported" : "pending";
		const adapter = capability === "supported" ? record.format.replace(/-jsonl$/u, "") : "none";
		const row = adapters.get(key) ?? { harness: record.harness, format: record.format, records: 0, bytes: 0, adapter, capability };
		row.records++;
		row.bytes += record.size;
		adapters.set(key, row);
	}
	return {
		totals: { records: records.length, bytes: records.reduce((sum, record) => sum + record.size, 0), byDisposition, byHarness },
		adapterMatrix: [...adapters.values()].sort((left, right) => left.harness.localeCompare(right.harness) || left.format.localeCompare(right.format)),
	};
}

export async function inventory(options: InventoryOptions): Promise<InventoryReport> {
	const now = options.now ?? (() => new Date());
	const snapshotAt = now().toISOString();
	const destination = await assertSafeDestination(options.destination, options.roots);
	await fs.mkdir(destination, { recursive: true });
	const pressureBefore = await readIoPressure(now);
	const records = await planRecords(options, snapshotAt);
	if (options.mode === "copy") {
		for (const record of records) {
			if (record.disposition === "pending" || record.disposition === "quarantined") {
				record.sha256Before = await sha256File(record.sourcePath);
			}
		}
	}
	const formula = estimate(records);
	const existingCopyBytes = options.mode === "copy" ? await measureExistingCopies(destination, records) : 0;
	const remainingCopyBytes = Math.max(0, formula.originals - existingCopyBytes);
	// Normalized staging and temporary export are different phases; both overlap the retained backup and DB footprint, not each other.
	const requiredBytes = remainingCopyBytes + formula.stagingDb + formula.indexes + formula.wal + Math.max(formula.normalized, formula.temporaryExport);
	const fileSystem = await fs.statfs(destination);
	const freeBytes = Number(fileSystem.bavail) * Number(fileSystem.bsize);
	const copyBudgetBytes = options.copyBudgetBytes ?? Number.MAX_SAFE_INTEGER;
	if (options.mode === "copy") {
		if (freeBytes < requiredBytes) throw new Error(`Insufficient free space: ${freeBytes} available, ${requiredBytes} required`);
		let copiedBytes = 0;
		for (const record of records) {
			if (record.disposition !== "pending" && record.disposition !== "quarantined") continue;
			const quarantined = record.disposition === "quarantined";
			if (copiedBytes + record.size > copyBudgetBytes) {
				record.reason = "copy-budget-deferred";
				continue;
			}
			try {
				const outcome = await copyStableFile(record.sourcePath, destination, options.retries ?? 1, options.afterCopyAttempt);
				record.sha256Before = outcome.before;
				record.sha256After = outcome.after;
				record.attempts = outcome.attempts;
				if ("copy" in outcome) {
					record.copySha256 = outcome.copy;
					record.copyPath = outcome.copyPath;
					record.disposition = quarantined ? "quarantined" : "copied";
					record.reason = quarantined ? `stable-hash-verified-quarantine:${record.reason}` : "stable-hash-verified-copy";
					copiedBytes += record.size;
				} else {
					record.disposition = "pending";
					record.reason = "source-changed-during-copy";
				}
			} catch (error) {
				record.disposition = "pending";
				record.reason = error instanceof Error ? `copy-failed:${error.name}` : "copy-failed:unknown";
			}
		}
	}
	const pressureAfter = await readIoPressure(now);
	const summary = summarize(records);
	const originalsStable = records.every(record => record.sha256Before === null || record.sha256Before === record.sha256After);
	return {
		schema: "omp.wcdb.inventory.v1",
		toolVersion: "1",
		snapshotAt,
		since: options.since.toISOString(),
		mode: options.mode,
		destination,
		roots: [...options.roots].sort((left, right) => left.name.localeCompare(right.name)),
		preflight: { requiredBytes, existingCopyBytes, remainingCopyBytes, freeBytes, copyBudgetBytes, sufficient: freeBytes >= requiredBytes, formula, ioPressure: [pressureBefore, pressureAfter] },
		...summary,
		records,
		noProductionMutation: { sourceWrites: 0, sourceDeletes: 0, sourcePermissionChanges: 0, destinationOnlyWrites: true, originalsStable },
	};
}

export function stableJson(value: unknown): string {
	return `${JSON.stringify(value, (_key, candidate) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
		return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
	}, 2)}\n`;
}
