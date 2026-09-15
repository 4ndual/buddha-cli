#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stableJson } from "../inventory";

interface ManifestEntry {
	candidateRelativePath: string;
	bytes: number;
	candidateAllocatedBytes: number;
	sha256: string;
	candidateDevice: number;
	candidateInode: number;
	candidateLinkCount: number;
	disposition: "redundant-authoritative-match" | "preserve-no-authoritative-match";
	authoritativeDestination?: string;
}

const [candidateArgument, manifestArgument, approvedBy, receiptArgument, afterManifestArgument, outcomesArgument] = process.argv.slice(2);
if (!candidateArgument || !manifestArgument || !approvedBy || !receiptArgument || !afterManifestArgument || !outcomesArgument) {
	throw new Error("Usage: bun reclaim-approved-subset.ts CANDIDATE_ROOT MANIFEST_JSONL APPROVED_BY RECEIPT_JSON AFTER_MANIFEST_JSONL OUTCOMES_JSONL");
}
if (approvedBy !== "WCDBMigrationCoordinator2.WCDBSafetyFinal") {
	throw new Error("Exact WCDBSafetyFinal approval identity is required");
}

async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

const candidateRoot = await fs.realpath(path.resolve(candidateArgument));
if (candidateRoot !== "/home/andual/Projects/.omp-wcdb-team/copies/wcdb-inventory-20260915") {
	throw new Error(`Unexpected deletion root: ${candidateRoot}`);
}
const manifestPath = path.resolve(manifestArgument);
const manifestText = await fs.readFile(manifestPath, "utf8");
const manifestSha256 = new Bun.CryptoHasher("sha256").update(manifestText).digest("hex");
if (manifestSha256 !== "c59e070804e4c008e5484ad6729bebd3b1168631d02de1b81c826f4a38c36e30") {
	throw new Error(`Deletion manifest is not the reviewed manifest: ${manifestSha256}`);
}
const entries = manifestText
	.trimEnd()
	.split("\n")
	.map((line) => JSON.parse(line) as ManifestEntry);
if (entries.length !== 1460) throw new Error(`Reviewed manifest count changed: ${entries.length}`);
const redundant = entries.filter((entry) => entry.disposition === "redundant-authoritative-match");
const preserved = entries.filter((entry) => entry.disposition === "preserve-no-authoritative-match");
if (redundant.length !== 1458 || preserved.length !== 2) throw new Error("Reviewed subset counts changed");

const before = await fs.statfs(candidateRoot);
const beforeAvailableBytes = before.bavail * before.bsize;
for (const entry of entries) {
	const candidatePath = path.resolve(candidateRoot, entry.candidateRelativePath);
	if (!candidatePath.startsWith(`${candidateRoot}${path.sep}`)) throw new Error(`Candidate path escapes root: ${entry.candidateRelativePath}`);
	const stat = await fs.lstat(candidatePath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || stat.dev !== entry.candidateDevice || stat.ino !== entry.candidateInode || stat.nlink !== 1) {
		throw new Error(`Candidate metadata changed since review: ${candidatePath}`);
	}
	if ((await sha256File(candidatePath)) !== entry.sha256) throw new Error(`Candidate hash changed since review: ${candidatePath}`);
	if (entry.disposition === "redundant-authoritative-match") {
		if (!entry.authoritativeDestination) throw new Error(`Redundant entry lacks authoritative destination: ${candidatePath}`);
		const authoritativeRealPath = await fs.realpath(entry.authoritativeDestination);
		if (!authoritativeRealPath.startsWith("/home/andual/Projects/.turso-migration-owned/backup/corpus-2026-09-15/")) {
			throw new Error(`Authoritative path changed: ${authoritativeRealPath}`);
		}
		if ((await sha256File(authoritativeRealPath)) !== entry.sha256) throw new Error(`Authoritative hash changed: ${authoritativeRealPath}`);
	}
}

for (const entry of redundant) await fs.unlink(path.resolve(candidateRoot, entry.candidateRelativePath));
const deletionOutcomes = [];
for (const entry of redundant) {
	const candidatePath = path.resolve(candidateRoot, entry.candidateRelativePath);
	try {
		await fs.lstat(candidatePath);
		throw new Error(`Deleted candidate remains: ${candidatePath}`);
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const authoritativePath = await fs.realpath(entry.authoritativeDestination!);
	const authoritativeSha256 = await sha256File(authoritativePath);
	if (authoritativeSha256 !== entry.sha256) throw new Error(`Post-delete authoritative mismatch: ${authoritativePath}`);
	deletionOutcomes.push({
		relativePath: entry.candidateRelativePath,
		bytes: entry.bytes,
		allocatedBytes: entry.candidateAllocatedBytes,
		sha256: entry.sha256,
		outcome: "deleted",
		authoritativePath,
		postDeleteAuthoritativeSha256: authoritativeSha256,
	});
}
const outcomesText = `${deletionOutcomes.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
await fs.writeFile(path.resolve(outcomesArgument), outcomesText);

const preservedAfter = [];
for (const entry of preserved) {
	const candidatePath = path.resolve(candidateRoot, entry.candidateRelativePath);
	const stat = await fs.lstat(candidatePath);
	const sha256 = await sha256File(candidatePath);
	if (stat.size !== entry.bytes || sha256 !== entry.sha256 || stat.nlink !== 1) throw new Error(`Preserved entry changed: ${candidatePath}`);
	preservedAfter.push({ relativePath: entry.candidateRelativePath, bytes: stat.size, allocatedBytes: stat.blocks * 512, sha256, device: stat.dev, inode: stat.ino, linkCount: stat.nlink });
}
preservedAfter.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
const afterManifestText = `${preservedAfter.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
await fs.writeFile(path.resolve(afterManifestArgument), afterManifestText);
const after = await fs.statfs(candidateRoot);
const afterAvailableBytes = after.bavail * after.bsize;
const expectedReclaimBytes = redundant.reduce((sum, entry) => sum + entry.candidateAllocatedBytes, 0);
const receipt = {
	schema: "omp.wcdb.redundant-copy-deletion.v1",
	deletedAt: new Date().toISOString(),
	approvedBy,
	approvalScope: "Only entries marked redundant-authoritative-match in the pinned reviewed manifest",
	candidateRoot,
	before: {
		manifestPath,
		manifestSha256,
		files: entries.length,
		availableBytes: beforeAvailableBytes,
	},
	deleted: {
		files: redundant.length,
		apparentBytes: redundant.reduce((sum, entry) => sum + entry.bytes, 0),
		expectedAllocatedBytes: expectedReclaimBytes,
		outcomesPath: path.resolve(outcomesArgument),
		outcomesSha256: new Bun.CryptoHasher("sha256").update(outcomesText).digest("hex"),
	},
	preserved: {
		files: preservedAfter.length,
		apparentBytes: preservedAfter.reduce((sum, entry) => sum + entry.bytes, 0),
		allocatedBytes: preservedAfter.reduce((sum, entry) => sum + entry.allocatedBytes, 0),
		manifestPath: path.resolve(afterManifestArgument),
		manifestSha256: new Bun.CryptoHasher("sha256").update(afterManifestText).digest("hex"),
	},
	after: {
		availableBytes: afterAvailableBytes,
		actualAvailableByteIncrease: afterAvailableBytes - beforeAvailableBytes,
	},
	verification: {
		allCandidatesReverifiedBeforeDeletion: true,
		allAuthoritativeMatchesReverifiedBeforeDeletion: true,
		allAuthoritativeMatchesReverifiedAfterDeletion: true,
		allPreservedFilesRehashedAfterDeletion: true,
		sharedSnapshotMutation: false,
		originalMutation: false,
		tursoMutation: false,
		activeSessionMutation: false,
		productionMutation: false,
	},
};
await fs.writeFile(path.resolve(receiptArgument), stableJson(receipt));
process.stdout.write(stableJson(receipt));
