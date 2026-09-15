import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stableJson } from "./inventory";

interface CorpusItem {
	namespace: string;
	destination?: string;
	bytes: number;
	sha256?: string;
	disposition: "copied" | "excluded" | "quarantined";
}

interface CorpusManifest {
	schemaVersion: number;
	backupRoot: string;
	summary: { copied: number; excluded: number; quarantined: number };
	items: CorpusItem[];
}

interface DatabaseItem {
	destination?: string;
	snapshotBytes?: number;
	sha256?: string;
	copiedHash?: string;
	hashMatches?: boolean;
	integrity?: string[];
	disposition: "snapshotted" | "missing";
}

interface DatabaseManifest {
	schemaVersion: number;
	items: DatabaseItem[];
}

async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	const stream = Bun.file(filePath).stream();
	for await (const chunk of stream) hasher.update(chunk);
	return hasher.digest("hex");
}

function requireArgument(name: string): string {
	const index = Bun.argv.indexOf(name);
	const value = index >= 0 ? Bun.argv[index + 1] : undefined;
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

function assertContained(root: string, candidate: string): void {
	const relative = path.relative(root, candidate);
	if (relative === "" || relative === ".") return;
	if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
		throw new Error(`Path escapes immutable root: ${candidate}`);
	}
}

async function verifyImmutableFile(root: string, filePath: string, expectedSize: number, expectedHash: string): Promise<void> {
	assertContained(root, filePath);
	const stat = await fs.lstat(filePath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular immutable file: ${filePath}`);
	if ((stat.mode & 0o222) !== 0) throw new Error(`Snapshot file remains writable: ${filePath}`);
	if (stat.size !== expectedSize) throw new Error(`Size mismatch for ${filePath}: ${stat.size} != ${expectedSize}`);
	const actualHash = await sha256File(filePath);
	if (actualHash !== expectedHash) throw new Error(`SHA-256 mismatch for ${filePath}: ${actualHash} != ${expectedHash}`);
}

async function main(): Promise<void> {
	const manifestPath = path.resolve(requireArgument("--manifest"));
	const expectedManifestHash = requireArgument("--manifest-sha256");
	const databaseManifestPath = path.resolve(requireArgument("--database-manifest"));
	const outputPath = path.resolve(requireArgument("--output"));
	const manifestHash = await sha256File(manifestPath);
	if (manifestHash !== expectedManifestHash) throw new Error(`Manifest SHA-256 mismatch: ${manifestHash} != ${expectedManifestHash}`);
	const manifest = (await Bun.file(manifestPath).json()) as CorpusManifest;
	if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.items)) throw new Error("Unsupported corpus manifest schema");
	const root = await fs.realpath(manifest.backupRoot);
	const rootStat = await fs.lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o222) !== 0) throw new Error("Immutable snapshot root is not a sealed directory");
	const counts = { copied: 0, excluded: 0, quarantined: 0 };
	let copiedBytes = 0;
	const inventoryHasher = new Bun.CryptoHasher("sha256");
	for (const item of manifest.items) {
		counts[item.disposition]++;
		if (item.disposition !== "copied") continue;
		if (!item.destination || !item.sha256) throw new Error(`Copied item lacks destination or hash in ${item.namespace}`);
		const destination = path.resolve(item.destination);
		await verifyImmutableFile(root, destination, item.bytes, item.sha256);
		copiedBytes += item.bytes;
		inventoryHasher.update(`${item.namespace}\0${path.relative(root, destination)}\0${item.bytes}\0${item.sha256}\n`);
	}
	for (const disposition of ["copied", "excluded", "quarantined"] as const) {
		if (counts[disposition] !== manifest.summary[disposition]) {
			throw new Error(`${disposition} count mismatch: ${counts[disposition]} != ${manifest.summary[disposition]}`);
		}
	}
	const databaseManifestHash = await sha256File(databaseManifestPath);
	const databaseManifest = (await Bun.file(databaseManifestPath).json()) as DatabaseManifest;
	if (databaseManifest.schemaVersion !== 1 || !Array.isArray(databaseManifest.items)) throw new Error("Unsupported database manifest schema");
	let databaseBytes = 0;
	let databaseSnapshots = 0;
	let databaseMissing = 0;
	for (const item of databaseManifest.items) {
		if (item.disposition === "missing") {
			databaseMissing++;
			continue;
		}
		if (!item.destination || item.snapshotBytes === undefined || !item.sha256 || !item.hashMatches || item.sha256 !== item.copiedHash || item.integrity?.some(result => result !== "ok")) {
			throw new Error(`Database snapshot receipt is not accepted: ${item.destination ?? "missing destination"}`);
		}
		const destination = path.resolve(item.destination);
		await verifyImmutableFile(root, destination, item.snapshotBytes, item.sha256);
		databaseSnapshots++;
		databaseBytes += item.snapshotBytes;
	}
	const receipt = {
		schema: "omp.wcdb.shared-corpus-verification.v1",
		verifiedAt: new Date().toISOString(),
		readOnlySource: true,
		productionMutation: false,
		snapshotRoot: root,
		manifest: { path: manifestPath, sha256: manifestHash, schemaVersion: manifest.schemaVersion },
		verification: {
			copiedItems: counts.copied,
			copiedBytes,
			excludedItems: counts.excluded,
			quarantinedItems: counts.quarantined,
			pendingItems: 0,
			itemSequenceSha256: inventoryHasher.digest("hex"),
			allCopiedFilesRehashed: true,
			allCopiedFilesSealedReadOnly: true,
		},
		databaseSnapshots: {
			manifestPath: databaseManifestPath,
			manifestSha256: databaseManifestHash,
			snapshottedItems: databaseSnapshots,
			explicitlyMissingItems: databaseMissing,
			bytes: databaseBytes,
			allPresentSnapshotsRehashed: true,
			allPresentIntegrityReceiptsOk: true,
		},
		capacity: {
			duplicateSourceCopyBytes: 0,
			sharedImmutableInputBytes: copiedBytes,
			note: "Mutable normalization, WCDB database, WAL, indexes, and export outputs remain isolated under the WCDB team root.",
		},
	};
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await Bun.write(outputPath, stableJson(receipt));
	console.log(JSON.stringify(receipt));
}

if (import.meta.main) await main();
