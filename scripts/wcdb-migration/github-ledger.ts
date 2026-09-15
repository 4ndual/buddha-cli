#!/usr/bin/env bun
import { stableJson } from "./inventory";

interface ReleaseAsset {
	name: string;
	size: number;
	digest: string | null;
	content_type: string;
	browser_download_url: string;
}

interface Release {
	tag_name: string;
	published_at: string;
	assets: ReleaseAsset[];
}

interface TreeItem {
	path: string;
	type: "blob" | "tree";
	sha: string;
	size?: number;
}

interface TreeResponse {
	sha: string;
	truncated: boolean;
	tree: TreeItem[];
}

interface LedgerRecord {
	repository: string;
	location: string;
	kind: "release-asset" | "tree-candidate";
	size: number;
	hash: string | null;
	hashKind: "sha256" | "git-sha1" | "unknown";
	disposition: "excluded" | "pending";
	reason: string;
	provenance: { status: "source-recorded"; source: string; acquiredAt: string };
}

export function isGitHubSessionCandidate(candidate: string): boolean {
	return /\.(?:jsonl|bundle)$/iu.test(candidate) || /(?:^|\/)tests?\/fixtures?\/(?:[^/]+\/)*[^/]*session[^/]*\.json$/iu.test(candidate);
}

function releaseDisposition(asset: ReleaseAsset): Pick<LedgerRecord, "disposition" | "reason"> {
	if (/\.(?:jsonl|bundle)$/iu.test(asset.name) || /(?:session|archive|manifest)/iu.test(asset.name)) {
		return { disposition: "pending", reason: "remote-session-like-asset-not-downloaded" };
	}
	if (/^omp-(?:darwin|linux|windows)/u.test(asset.name) || /application\/octet-stream/iu.test(asset.content_type)) {
		return { disposition: "excluded", reason: "non-session-executable-or-package-asset" };
	}
	return { disposition: "excluded", reason: "non-session-release-asset" };
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "omp-wcdb-inventory/1" } });
	if (!response.ok) throw new Error(`GitHub request failed (${response.status}) for ${url}`);
	return (await response.json()) as T;
}
async function fetchReleasePages(repository: string, since: Date): Promise<Release[]> {
	const releases: Release[] = [];
	for (let page = 1; page <= 10; page++) {
		const batch = await fetchJson<Release[]>(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`);
		const inRange = batch.filter(release => new Date(release.published_at).getTime() >= since.getTime());
		releases.push(...inRange);
		if (batch.length < 100 || batch.some(release => new Date(release.published_at).getTime() < since.getTime())) break;
	}
	return releases;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const outputIndex = args.indexOf("--output");
	const sinceIndex = args.indexOf("--since");
	if (outputIndex === -1 || !args[outputIndex + 1]) throw new Error("Usage: bun github-ledger.ts REPO... --output FILE [--since ISO]");
	const output = args[outputIndex + 1]!;
	const since = new Date(sinceIndex === -1 ? "1970-01-01T00:00:00.000Z" : (args[sinceIndex + 1] ?? "invalid"));
	if (Number.isNaN(since.getTime())) throw new Error("Invalid --since date");
	const firstFlag = Math.min(...[outputIndex, sinceIndex].filter(index => index >= 0));
	const repositories = args.slice(0, firstFlag).sort();
	if (repositories.length === 0) throw new Error("At least one repository is required");
	const acquiredAt = new Date().toISOString();
	const records: LedgerRecord[] = [];
	const repositoryHeads: Array<{ repository: string; treeSha: string; treeTruncated: boolean; releases: number }> = [];
	for (const repository of repositories) {
		const [releases, tree] = await Promise.all([
			fetchReleasePages(repository, since),
			fetchJson<TreeResponse>(`https://api.github.com/repos/${repository}/git/trees/main?recursive=1`),
		]);
		repositoryHeads.push({ repository, treeSha: tree.sha, treeTruncated: tree.truncated, releases: releases.length });
		for (const release of releases) {
			for (const asset of release.assets) {
				const decision = releaseDisposition(asset);
				records.push({ repository, location: `release:${release.tag_name}/${asset.name}`, kind: "release-asset", size: asset.size, hash: asset.digest?.replace(/^sha256:/u, "") ?? null, hashKind: asset.digest?.startsWith("sha256:") ? "sha256" : "unknown", ...decision, provenance: { status: "source-recorded", source: `github-releases-api:${release.published_at}`, acquiredAt } });
			}
		}
		if (tree.truncated) {
			records.push({ repository, location: `tree:${tree.sha}`, kind: "tree-candidate", size: 0, hash: tree.sha, hashKind: "git-sha1", disposition: "pending", reason: "recursive-tree-response-truncated", provenance: { status: "source-recorded", source: "github-git-tree-api", acquiredAt } });
		}
		for (const item of tree.tree) {
			if (item.type !== "blob" || !isGitHubSessionCandidate(item.path)) continue;
			const testFixture = /(?:^|\/)tests?\/(?:fixtures?\/)?/iu.test(item.path);
			records.push({ repository, location: `tree:${item.path}`, kind: "tree-candidate", size: item.size ?? 0, hash: item.sha, hashKind: "git-sha1", disposition: testFixture ? "excluded" : "pending", reason: testFixture ? "non-session-test-fixture" : "committed-session-like-artifact-needs-content-review", provenance: { status: "source-recorded", source: `github-git-tree-api:${tree.sha}`, acquiredAt } });
		}
	}
	records.sort((left, right) => left.repository.localeCompare(right.repository) || left.location.localeCompare(right.location));
	const totals = records.reduce((summary, record) => {
		summary.records++;
		summary.bytes += record.size;
		summary[record.disposition]++;
		return summary;
	}, { records: 0, bytes: 0, excluded: 0, pending: 0 });
	await Bun.write(output, stableJson({ schema: "omp.wcdb.github-source-ledger.v1", acquiredAt, repositoryHeads, totals, records, networkPolicy: { metadataOnly: true, downloadedAssets: 0, executableDownloads: 0, secretMaterialCaptured: false } }));
	process.stdout.write(stableJson({ output, totals, repositoryHeads }));
}

if (import.meta.main) await main();
