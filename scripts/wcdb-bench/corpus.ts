import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CorpusAccounting, CorpusRecordDisposition } from "./types";
import { canonicalJson, sha256File, sha256Text, streamTextLines } from "./util";

interface LedgerDisposition {
	disposition: CorpusRecordDisposition["disposition"];
	reason: string;
	originId: string | null;
	provenance: Record<string, string | number | boolean | null>;
}
interface LedgerItem {
	keys: string[];
	mapping: LedgerDisposition;
	hash: string;
	path: string;
	bytes: number;
}

interface LoadedLedger {
	lookup: Map<string, LedgerDisposition>;
	items: LedgerItem[];
}


interface ParsedRecord {
	value: Record<string, unknown> | null;
	kind: string;
	recordId: string;
	parentId: string | null;
	originId: string | null;
	attachmentHashes: string[];
	contextEligible: boolean;
}

export interface AccountCorpusOptions {
	root: string;
	recordsPath: string;
	inventoryLedgerPath?: string;
	normalizationLedgerPath?: string;
	maxInputBytes: number;
	maxRecordBytes: number;
}

async function walkFiles(root: string): Promise<{ files: string[]; symlinks: string[] }> {
	const pending = [root];
	const files: string[] = [];
	const symlinks: string[] = [];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		let entries: fs.Dirent[];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [], symlinks: [] };
			throw error;
		}
		for (const entry of entries.toSorted((a, b) => b.name.localeCompare(a.name))) {
			const child = path.join(current, entry.name);
			if (entry.isDirectory()) pending.push(child);
			else if (entry.isFile()) files.push(child);
			else if (entry.isSymbolicLink()) symlinks.push(child);
		}
	}
	return { files: files.toSorted(), symlinks: symlinks.toSorted() };
}

function findStrings(value: unknown, predicate: (key: string) => boolean, into: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) findStrings(item, predicate, into);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (predicate(key) && typeof child === "string") into.push(child);
		findStrings(child, predicate, into);
	}
}

function parseRecord(text: string, fileSha256: string, line: number): ParsedRecord {
	let value: Record<string, unknown> | null = null;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
	} catch {
		return {
			value: null,
			kind: "malformed-json",
			recordId: `${fileSha256}:${line}`,
			parentId: null,
			originId: null,
			attachmentHashes: [],
			contextEligible: false,
		};
	}
	if (!value) {
		return {
			value: null,
			kind: "non-object-json",
			recordId: `${fileSha256}:${line}`,
			parentId: null,
			originId: null,
			attachmentHashes: [],
			contextEligible: false,
		};
	}
	const recordId = [value.id, value.event_hash, value.eventHash, value.native_entry_id].find(item => typeof item === "string") as string | undefined;
	const parentId = [value.parentId, value.parent_id, value.parent_hash, value.parentHash].find(item => typeof item === "string") as string | undefined;
	const originId = [value.origin_id, value.originId, value.sessionId, value.session_id].find(item => typeof item === "string") as string | undefined;
	const kindValue = [value.type, value.kind, value.role].find(item => typeof item === "string") as string | undefined;
	const attachmentHashes: string[] = [];
	findStrings(value, key => /^(sha256|attachmentHash|attachment_hash|payloadHash|payload_hash)$/i.test(key), attachmentHashes);
	const kind = kindValue ?? "json-record";
	return {
		value,
		kind,
		recordId: recordId ?? `${fileSha256}:${line}`,
		parentId: parentId ?? null,
		originId: originId ?? null,
		attachmentHashes: [...new Set(attachmentHashes.filter(item => /^[a-f0-9]{64}$/i.test(item)))].toSorted(),
		contextEligible: kind !== "custom" && kind !== "session" && kind !== "header",
	};
}

async function loadLedger(filePath: string | undefined): Promise<LoadedLedger> {
	const result: LoadedLedger = { lookup: new Map<string, LedgerDisposition>(), items: [] };
	if (!filePath) return result;
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
		throw error;
	}
	let rows: unknown[] = [];
	try {
		const parsed: unknown = JSON.parse(text);
		if (Array.isArray(parsed)) rows = parsed;
		else if (parsed && typeof parsed === "object") {
			const object = parsed as Record<string, unknown>;
			const candidates = [object.items, object.records, object.files, object.dispositions];
			rows = (candidates.find(Array.isArray) as unknown[] | undefined) ?? [parsed];
		}
	} catch {
		rows = text
			.split("\n")
			.filter(line => line.trim().length > 0)
			.map(line => {
				try {
					return JSON.parse(line) as unknown;
				} catch {
					return null;
				}
			});
	}
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const object = row as Record<string, unknown>;
		const keys = [
			object.copiedPath,
			object.copyPath,
			object.path,
			object.sourcePath,
			object.relativePath,
			object.source,
			object.sha256,
			object.sourceSha256,
			object.source_sha256,
		].filter((value): value is string => typeof value === "string");
		if (keys.length === 0) continue;
		const rawStatus = String(object.disposition ?? object.status ?? "").toLowerCase();
		let disposition: LedgerDisposition["disposition"] = "copied-awaiting-normalization";
		if (rawStatus.includes("quarant")) disposition = "quarantined";
		else if (rawStatus.includes("exclude")) disposition = "excluded";
		else if (rawStatus.includes("import")) disposition = "imported";
		else if (rawStatus.includes("normal") || rawStatus.includes("resumable") || rawStatus.includes("archive-only")) disposition = "normalized";
		const originId = [object.origin_id, object.originId].find(value => typeof value === "string") as string | undefined;
		const provenance: Record<string, string | number | boolean | null> = {};
		for (const field of ["source", "sourceNamespace", "adapter", "adapterVersion", "acquiredAt", "status", "format", "version_id", "context_hash", "normalized_sha256", "source_records", "normalized_bytes"] as const) {
			const value = object[field];
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) provenance[field] = value;
		}
		const mapped = {
			disposition,
			reason: String(object.reason ?? object.quarantineReason ?? `ledger status: ${rawStatus || "unspecified"}`),
			originId: originId ?? null,
			provenance,
		};
		for (const key of keys) result.lookup.set(key, mapped);
		const ledgerHash = [
			object.copySha256,
			object.sha256After,
			object.sha256Before,
			object.sha256,
			object.sourceSha256,
			object.source_sha256,
		].find(value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) as string | undefined;
		const safePath = [object.copyPath, object.relativePath, object.path, object.source].find(value => typeof value === "string") as string | undefined;
		result.items.push({
			keys,
			mapping: mapped,
			hash: ledgerHash ?? sha256Text(canonicalJson(object)),
			path: safePath ?? `ledger-item-${result.items.length + 1}`,
			bytes: typeof object.size === "number" ? object.size : 0,
		});
	}
	return result;
}

function ledgerDisposition(
	ledger: LoadedLedger,
	relativePath: string,
	absolutePath: string,
	fileSha256: string,
): LedgerDisposition | null {
	return ledger.lookup.get(relativePath) ?? ledger.lookup.get(absolutePath) ?? ledger.lookup.get(fileSha256) ?? null;
}

export async function accountCorpus(options: AccountCorpusOptions): Promise<CorpusAccounting> {
	await fs.mkdir(path.dirname(options.recordsPath), { recursive: true });
	await Bun.write(options.recordsPath, "");
	const recordOutput = await fs.open(options.recordsPath, "a");
	const inventoryLedger = await loadLedger(options.inventoryLedgerPath);
	const normalizationLedger = await loadLedger(options.normalizationLedgerPath);
	const { files, symlinks } = await walkFiles(options.root);
	const fileManifestHasher = new Bun.CryptoHasher("sha256");
	const dispositions: Record<string, number> = {};
	let records = 0;
	let bytes = 0;
	let parseErrors = 0;
	let missingParents = 0;
	let cycles = 0;
	let branchHeads = 0;
	let attachmentReferences = 0;
	let missingAttachments = 0;
	let contextHashes = 0;
	let stoppedForCap = false;
	try {
		for (const symlinkPath of symlinks) {
			const relativePath = path.relative(options.root, symlinkPath);
			const target = await fs.readlink(symlinkPath);
			const symlinkHash = sha256Text(`symlink\0${relativePath}\0${target}`);
			const linkBytes = Buffer.byteLength(target);
			fileManifestHasher.update(`${relativePath}\0${symlinkHash}\0symlink:${linkBytes}\n`);
			const receipt: CorpusRecordDisposition = {
				recordId: `${symlinkHash}:symlink`,
				fileSha256: symlinkHash,
				recordSha256: symlinkHash,
				path: relativePath,
				line: null,
				bytes: linkBytes,
				kind: "symbolic-link",
				disposition: "excluded",
				reason: "symbolic link target was not followed; explicitly excluded to preserve the copied-corpus boundary",
				originId: null,
				branchHead: null,
				contextHash: null,
				parentHash: null,
				attachmentHashes: [],
				provenance: { source: "copied-corpus", symlinkTargetHash: sha256Text(target) },
			};
			await recordOutput.write(`${JSON.stringify(receipt)}\n`);
			records++;
			bytes += linkBytes;
			dispositions.excluded = (dispositions.excluded ?? 0) + 1;
		}
		for (let index = 0; index < inventoryLedger.items.length; index++) {
			const item = inventoryLedger.items[index];
			const normalized = item.keys.map(key => normalizationLedger.lookup.get(key)).find(value => value !== undefined);
			const mapping = normalized ?? item.mapping;
			const receipt: CorpusRecordDisposition = {
				recordId: `inventory:${item.hash}:${index}`,
				fileSha256: item.hash,
				recordSha256: item.hash,
				path: item.path,
				line: null,
				bytes: item.bytes,
				kind: "inventory-ledger-item",
				disposition: mapping.disposition,
				reason: mapping.reason,
				originId: mapping.originId,
				branchHead: null,
				contextHash: null,
				parentHash: null,
				attachmentHashes: [],
				provenance: { ledger: "inventory", ...mapping.provenance },
			};
			await recordOutput.write(`${JSON.stringify(receipt)}\n`);
			records++;
			dispositions[receipt.disposition] = (dispositions[receipt.disposition] ?? 0) + 1;
		}
		for (const filePath of files) {
			const stat = await fs.stat(filePath);
			const relativePath = path.relative(options.root, filePath);
			if (bytes + stat.size > options.maxInputBytes) {
				stoppedForCap = true;
				const fileSha256 = await sha256File(filePath);
				const disposition: CorpusRecordDisposition = {
					recordId: `${fileSha256}:file`,
					fileSha256,
					recordSha256: fileSha256,
					path: relativePath,
					line: null,
					bytes: stat.size,
					kind: "byte-cap-exclusion",
					disposition: "excluded",
					reason: `input byte cap ${options.maxInputBytes} exceeded before file`,
					originId: null,
					branchHead: null,
					contextHash: null,
					parentHash: null,
					attachmentHashes: [],
					provenance: { source: "copied-corpus", capApplied: true },
				};
				await recordOutput.write(`${JSON.stringify(disposition)}\n`);
				records++;
				dispositions.excluded = (dispositions.excluded ?? 0) + 1;
				fileManifestHasher.update(`${relativePath}\0${fileSha256}\0${stat.size}\n`);
				continue;
			}
			bytes += stat.size;
			const fileSha256 = await sha256File(filePath);
			fileManifestHasher.update(`${relativePath}\0${fileSha256}\0${stat.size}\n`);
			const isJsonLines = /\.(jsonl|ndjson)$/i.test(filePath);
			if (!isJsonLines) {
				const mapped = ledgerDisposition(normalizationLedger, relativePath, filePath, fileSha256) ?? ledgerDisposition(inventoryLedger, relativePath, filePath, fileSha256);
				const disposition: CorpusRecordDisposition = {
					recordId: `${fileSha256}:file`,
					fileSha256,
					recordSha256: fileSha256,
					path: relativePath,
					line: null,
					bytes: stat.size,
					kind: "opaque-file",
					disposition: mapped?.disposition ?? "copied-awaiting-normalization",
					reason: mapped?.reason ?? "copied file has no normalization/import mapping",
					originId: mapped?.originId ?? null,
					branchHead: null,
					contextHash: null,
					parentHash: null,
					attachmentHashes: [],
					provenance: { source: "copied-corpus", ...(mapped?.provenance ?? {}) },
				};
				await recordOutput.write(`${JSON.stringify(disposition)}\n`);
				records++;
				dispositions[disposition.disposition] = (dispositions[disposition.disposition] ?? 0) + 1;
				continue;
			}

			const ids = new Set<string>();
			const parents = new Map<string, string>();
			const hasChildren = new Set<string>();
			await streamTextLines(filePath, (text, line) => {
				if (text.trim().length === 0) return;
				const parsed = parseRecord(text, fileSha256, line);
				if (parsed.kind === "session" || parsed.kind === "header" || parsed.kind === "custom") return;
				ids.add(parsed.recordId);
				if (parsed.parentId) {
					parents.set(parsed.recordId, parsed.parentId);
					hasChildren.add(parsed.parentId);
				}
			});
			for (const parent of parents.values()) if (!ids.has(parent)) missingParents++;
			for (const id of ids) {
				const seen = new Set<string>();
				let cursor: string | undefined = id;
				while (cursor) {
					if (seen.has(cursor)) {
						cycles++;
						break;
					}
					seen.add(cursor);
					cursor = parents.get(cursor);
				}
			}
			branchHeads += [...ids].filter(id => !hasChildren.has(id)).length;
			const rollingContext = new Bun.CryptoHasher("sha256");
			const mapped = ledgerDisposition(normalizationLedger, relativePath, filePath, fileSha256) ?? ledgerDisposition(inventoryLedger, relativePath, filePath, fileSha256);
			await streamTextLines(filePath, async (text, line, recordBytes) => {
				if (text.trim().length === 0) return;
				const parsed = parseRecord(text, fileSha256, line);
				const oversized = recordBytes > options.maxRecordBytes;
				const malformed = parsed.value === null;
				if (malformed) parseErrors++;
				if (parsed.contextEligible && parsed.value) rollingContext.update(canonicalJson(parsed.value));
				const contextHash = parsed.contextEligible && parsed.value ? rollingContext.copy().digest("hex") : null;
				if (contextHash) contextHashes++;
				attachmentReferences += parsed.attachmentHashes.length;
				for (const hash of parsed.attachmentHashes) {
					if (!inventoryLedger.lookup.has(hash) && !normalizationLedger.lookup.has(hash)) missingAttachments++;
				}
				let disposition = mapped?.disposition ?? "copied-awaiting-normalization";
				let reason = mapped?.reason ?? "copied record has no normalization/import mapping";
				if (malformed) {
					disposition = "quarantined";
					reason = "malformed or non-object JSON record";
				} else if (oversized) {
					disposition = "quarantined";
					reason = `record exceeds byte cap ${options.maxRecordBytes}`;
				}
				const recordHash = sha256Text(text);
				const receipt: CorpusRecordDisposition = {
					recordId: parsed.recordId,
					fileSha256,
					recordSha256: recordHash,
					path: relativePath,
					line,
					bytes: recordBytes,
					kind: parsed.kind,
					disposition,
					reason,
					originId: parsed.originId ?? mapped?.originId ?? null,
					branchHead: hasChildren.has(parsed.recordId) ? null : recordHash,
					contextHash,
					parentHash: parsed.parentId,
					attachmentHashes: parsed.attachmentHashes,
					provenance: { source: "copied-corpus", ...(mapped?.provenance ?? {}) },
				};
				await recordOutput.write(`${JSON.stringify(receipt)}\n`);
				records++;
				dispositions[disposition] = (dispositions[disposition] ?? 0) + 1;
			});
		}
		await recordOutput.sync();
	} finally {
		await recordOutput.close();
	}
	const unresolved = (dispositions["copied-awaiting-normalization"] ?? 0) + (dispositions.quarantined ?? 0);
	const status = files.length === 0 || stoppedForCap || unresolved > 0 || missingParents > 0 || cycles > 0 || missingAttachments > 0 ? "blocked" : "measured";
	const reasons: string[] = [];
	if (files.length === 0) reasons.push("copied corpus has no regular files");
	if (stoppedForCap) reasons.push("input byte cap excluded one or more files");
	if (unresolved > 0) reasons.push(`${unresolved} records are awaiting normalization or quarantined`);
	if (missingParents > 0) reasons.push(`${missingParents} parent references are unresolved`);
	if (cycles > 0) reasons.push(`${cycles} cycles detected`);
	if (missingAttachments > 0) reasons.push(`${missingAttachments} attachment hashes have no ledger mapping`);
	return {
		status,
		reason: reasons.length > 0 ? reasons.join("; ") : undefined,
		root: options.root,
		files: files.length + symlinks.length,
		records,
		bytes,
		fileManifestHash: fileManifestHasher.digest("hex"),
		dispositions,
		parseErrors,
		missingParents,
		branchHeads,
		attachmentReferences,
		missingAttachments,
		contextHashes,
		recordsPath: options.recordsPath,
	};
}

export async function readBenchmarkRows(
	root: string,
	maxInputBytes: number,
	maxRecordBytes: number,
	visit: (row: { id: string; originId: string; parentId: string | null; kind: string; text: string; payload: Uint8Array }) => void | Promise<void>,
): Promise<{ rows: number; bytes: number }> {
	const { files } = await walkFiles(root);
	let rows = 0;
	let bytes = 0;
	for (const filePath of files) {
		const stat = await fs.stat(filePath);
		if (bytes + stat.size > maxInputBytes) continue;
		bytes += stat.size;
		const relativePath = path.relative(root, filePath);
		const fileSha256 = await sha256File(filePath);
		if (/\.(jsonl|ndjson)$/i.test(filePath)) {
			await streamTextLines(filePath, async (text, line, recordBytes) => {
				if (text.trim().length === 0 || recordBytes > maxRecordBytes) return;
				const parsed = parseRecord(text, fileSha256, line);
				if (!parsed.value) return;
				const canonical = canonicalJson(parsed.value);
				await visit({
					id: `${fileSha256}:${line}`,
					originId: parsed.originId ?? `file:${fileSha256}`,
					parentId: parsed.parentId,
					kind: parsed.kind,
					text: canonical.slice(0, 64 * 1024),
					payload: new TextEncoder().encode(canonical),
				});
				rows++;
			});
		} else {
			await visit({
				id: `${fileSha256}:file`,
				originId: `file:${fileSha256}`,
				parentId: null,
				kind: "opaque-file",
				text: relativePath,
				payload: new TextEncoder().encode(JSON.stringify({ path: relativePath, sha256: fileSha256, bytes: stat.size })),
			});
			rows++;
		}
	}
	return { rows, bytes };
}
