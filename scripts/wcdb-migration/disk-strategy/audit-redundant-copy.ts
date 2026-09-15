#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stableJson } from "../inventory";

interface SharedItem {
	destination?: string;
	namespace: string;
	relativePath: string;
	bytes: number;
	sha256?: string;
	disposition: "copied" | "excluded" | "quarantined";
}

interface SharedManifest {
	schemaVersion: number;
	backupRoot: string;
	summary: { copied: number; excluded: number; quarantined: number };
	items: SharedItem[];
}

interface AuditedFile {
	candidateRelativePath: string;
	bytes: number;
	candidateAllocatedBytes: number;
	sha256: string;
	candidateDevice: number;
	candidateInode: number;
	candidateLinkCount: number;
	disposition: "redundant-authoritative-match" | "preserve-no-authoritative-match";
	authoritativeRelativePath?: string;
	authoritativeDestination?: string;
	authoritativeDevice?: number;
	authoritativeInode?: number;
	authoritativeLinkCount?: number;
}

const [candidateArgument, sharedManifestArgument, summaryArgument, entriesArgument] = process.argv.slice(2);
if (!candidateArgument || !sharedManifestArgument || !summaryArgument || !entriesArgument) {
	throw new Error("Usage: bun audit-redundant-copy.ts CANDIDATE_ROOT SHARED_MANIFEST SUMMARY_JSON ENTRIES_JSONL");
}

async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}


async function walkFiles(root: string, current = root): Promise<string[]> {
	const result: string[] = [];
	const entries = await fs.readdir(current, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		const entryPath = path.join(current, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Symlink is not eligible for deletion: ${entryPath}`);
		if (entry.isDirectory()) result.push(...(await walkFiles(root, entryPath)));
		else if (entry.isFile()) result.push(entryPath);
		else throw new Error(`Unsupported filesystem entry: ${entryPath}`);
	}
	return result;
}

const candidateRoot = path.resolve(candidateArgument);
const candidateRealRoot = await fs.realpath(candidateRoot);
const ownedRoot = await fs.realpath("/home/andual/Projects/.omp-wcdb-team");
if (candidateRealRoot !== candidateRoot) throw new Error("Candidate root resolves through a symlink");
if (!candidateRealRoot.startsWith(`${ownedRoot}${path.sep}copies${path.sep}`)) {
	throw new Error("Candidate must be a copy below the WCDB team-owned copies directory");
}

const sharedManifestPath = await fs.realpath(sharedManifestArgument);
const sharedManifestText = await fs.readFile(sharedManifestPath, "utf8");
const sharedManifest = JSON.parse(sharedManifestText) as SharedManifest;
const authoritativeRoot = await fs.realpath(sharedManifest.backupRoot);
if (authoritativeRoot !== "/home/andual/Projects/.turso-migration-owned/backup/corpus-2026-09-15") {
	throw new Error(`Unexpected authoritative root: ${authoritativeRoot}`);
}
if (candidateRealRoot === authoritativeRoot || candidateRealRoot.startsWith(`${authoritativeRoot}${path.sep}`)) {
	throw new Error("Candidate overlaps the authoritative snapshot");
}

const byHashAndSize = new Map<string, SharedItem[]>();
for (const item of sharedManifest.items) {
	if (item.disposition !== "copied" || !item.sha256 || !item.destination) continue;
	const key = `${item.sha256}:${item.bytes}`;
	const matches = byHashAndSize.get(key) ?? [];
	matches.push(item);
	byHashAndSize.set(key, matches);
}
for (const matches of byHashAndSize.values()) {
	matches.sort((left, right) => `${left.namespace}/${left.relativePath}`.localeCompare(`${right.namespace}/${right.relativePath}`));
}

const candidateFiles = await walkFiles(candidateRealRoot);
const audited: AuditedFile[] = [];
for (const candidatePath of candidateFiles) {
	const candidateStat = await fs.lstat(candidatePath);
	if (candidateStat.nlink !== 1) throw new Error(`Candidate has hardlink aliases: ${candidatePath} (nlink=${candidateStat.nlink})`);
	const candidateHash = await sha256File(candidatePath);
	const expectedName = path.basename(candidatePath);
	if (!/^[0-9a-f]{64}$/u.test(expectedName) || expectedName !== candidateHash) {
		throw new Error(`Candidate content-address mismatch: ${candidatePath}`);
	}
	const matches = byHashAndSize.get(`${candidateHash}:${candidateStat.size}`);
	if (!matches?.length) {
		audited.push({
			candidateRelativePath: path.relative(candidateRealRoot, candidatePath),
			bytes: candidateStat.size,
			candidateAllocatedBytes: candidateStat.blocks * 512,
			sha256: candidateHash,
			candidateDevice: candidateStat.dev,
			candidateInode: candidateStat.ino,
			candidateLinkCount: candidateStat.nlink,
			disposition: "preserve-no-authoritative-match",
		});
		continue;
	}
	const authoritative = matches[0];
	const authoritativeDestination = await fs.realpath(authoritative.destination!);
	if (!authoritativeDestination.startsWith(`${authoritativeRoot}${path.sep}`)) {
		throw new Error(`Manifest destination escapes authoritative root: ${authoritativeDestination}`);
	}
	const authoritativeStat = await fs.lstat(authoritativeDestination);
	if (!authoritativeStat.isFile()) throw new Error(`Authoritative match is not a file: ${authoritativeDestination}`);
	if (authoritativeStat.size !== candidateStat.size) throw new Error(`Authoritative size changed: ${authoritativeDestination}`);
	if (authoritativeStat.dev === candidateStat.dev && authoritativeStat.ino === candidateStat.ino) {
		throw new Error(`Candidate aliases authoritative inode: ${candidatePath}`);
	}
	const authoritativeHash = await sha256File(authoritativeDestination);
	if (authoritativeHash !== candidateHash || authoritativeHash !== authoritative.sha256) {
		throw new Error(`Authoritative content changed: ${authoritativeDestination}`);
	}
	audited.push({
		candidateRelativePath: path.relative(candidateRealRoot, candidatePath),
		bytes: candidateStat.size,
		candidateAllocatedBytes: candidateStat.blocks * 512,
		sha256: candidateHash,
		candidateDevice: candidateStat.dev,
		candidateInode: candidateStat.ino,
		candidateLinkCount: candidateStat.nlink,
		disposition: "redundant-authoritative-match",
		authoritativeRelativePath: `${authoritative.namespace}/${authoritative.relativePath}`,
		authoritativeDestination,
		authoritativeDevice: authoritativeStat.dev,
		authoritativeInode: authoritativeStat.ino,
		authoritativeLinkCount: authoritativeStat.nlink,
	});
}

audited.sort((left, right) => left.candidateRelativePath.localeCompare(right.candidateRelativePath));
const entriesText = `${audited.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const entriesSha256 = new Bun.CryptoHasher("sha256").update(entriesText).digest("hex");
const candidateBytes = audited.reduce((sum, entry) => sum + entry.bytes, 0);
const uniqueHashes = new Set(audited.map((entry) => entry.sha256)).size;
const redundant = audited.filter((entry) => entry.disposition === "redundant-authoritative-match");
const preserved = audited.filter((entry) => entry.disposition === "preserve-no-authoritative-match");
const redundantBytes = redundant.reduce((sum, entry) => sum + entry.bytes, 0);
const preservedBytes = preserved.reduce((sum, entry) => sum + entry.bytes, 0);
const candidateAllocatedBytes = audited.reduce((sum, entry) => sum + entry.candidateAllocatedBytes, 0);
const redundantAllocatedBytes = redundant.reduce((sum, entry) => sum + entry.candidateAllocatedBytes, 0);
const preservedAllocatedBytes = preserved.reduce((sum, entry) => sum + entry.candidateAllocatedBytes, 0);
const sharedCopied = sharedManifest.items.filter((item) => item.disposition === "copied");
const summary = {
	schema: "omp.wcdb.redundant-copy-audit.v1",
	auditedAt: new Date().toISOString(),
	candidate: {
		root: candidateRealRoot,
		ownership: "WCDB team-owned partial inventory output",
		provenanceReceipts: [
			"/home/andual/Projects/.omp-wcdb-team/artifacts/inventory/eight-month-plan.json",
			"/home/andual/Projects/.omp-wcdb-team/artifacts/inventory/repository-history-copy.json",
		],
		files: audited.length,
		bytes: candidateBytes,
		allocatedBytes: candidateAllocatedBytes,
		uniqueHashes,
		manifestPath: path.resolve(entriesArgument),
		manifestSha256: entriesSha256,
		allRegularFiles: true,
		allLinkCountsOne: true,
		noAuthoritativeInodeAliases: true,
	},
	authoritative: {
		root: authoritativeRoot,
		manifestPath: sharedManifestPath,
		manifestSha256: new Bun.CryptoHasher("sha256").update(sharedManifestText).digest("hex"),
		manifestCopiedFiles: sharedCopied.length,
		manifestCopiedBytes: sharedCopied.reduce((sum, item) => sum + item.bytes, 0),
		allCandidateFilesRehashed: true,
		allMappedAuthoritativeFilesRehashed: true,
	},
	equivalence: {
		candidateFilesMapped: redundant.length,
		candidateBytesMapped: redundantBytes,
		candidateAllocatedBytesMapped: redundantAllocatedBytes,
		unmatchedFiles: preserved.length,
		unmatchedBytes: preservedBytes,
		unmatchedAllocatedBytes: preservedAllocatedBytes,
		mismatchedFiles: 0,
		mismatchedBytes: 0,
		completeCandidateAccounting: redundant.length + preserved.length === audited.length,
		completeRedundantSubsetEquivalence: true,
	},
	eligibility: {
		isSharedSnapshot: false,
		isOriginalSource: false,
		isTursoOwned: false,
		isActiveSessionPath: false,
		rootSafeToReclaim: preserved.length === 0,
		redundantFilesSafeToReclaim: redundant.length,
		redundantBytesSafeToReclaim: redundantBytes,
		redundantAllocatedBytesSafeToReclaim: redundantAllocatedBytes,
		preservedFiles: preserved.length,
		preservedBytes,
		preservedAllocatedBytes,
		reviewerApprovalRequiredBeforeDeletion: true,
	},
	productionMutation: false,
};
await fs.mkdir(path.dirname(path.resolve(summaryArgument)), { recursive: true });
await fs.writeFile(path.resolve(entriesArgument), entriesText);
await fs.writeFile(path.resolve(summaryArgument), stableJson(summary));
process.stdout.write(stableJson(summary));
