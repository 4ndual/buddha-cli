import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EventHash, VersionId } from "../contracts";
import { checksumJobJson, type JobJson } from "./checksum";
import { durableIo, type DurableIo, pathExists, writeJsonAtomicDurable } from "./durable-fs";

export interface ExportGenerationFile {
	relativePath: string;
	content: Uint8Array | string | AsyncIterable<Uint8Array>;
}

export interface ExportCutoff {
	originId: string;
	branchId: string;
	versionId: VersionId;
	headHash: EventHash | null;
}

export interface ExportManifestFile {
	path: string;
	byteLength: number;
	sha256: string;
}

export interface ExportGenerationManifest {
	schemaVersion: 1;
	generation: string;
	publication: "same-filesystem" | "cross-filesystem";
	cutoffs: readonly ExportCutoff[];
	files: readonly ExportManifestFile[];
	totalBytes: number;
	createdAt: string;
	manifestChecksum: string;
}

export interface ExportPublicationReceipt {
	generation: string;
	manifestChecksum: string;
	publishedPath: string;
	publishedAt: string;
	receiptChecksum: string;
}

export interface ExportReceiptStore {
	lookup(generation: string): Promise<ExportPublicationReceipt | null>;
	record(receipt: ExportPublicationReceipt): Promise<void>;
}

function receiptBody(receipt: Omit<ExportPublicationReceipt, "receiptChecksum">): JobJson {
	return {
		generation: receipt.generation,
		manifestChecksum: receipt.manifestChecksum,
		publishedPath: receipt.publishedPath,
		publishedAt: receipt.publishedAt,
	};
}

export class DurableExportReceiptStore implements ExportReceiptStore {
	readonly #directory: string;
	readonly #io: DurableIo;

	constructor(directory: string, io: DurableIo = durableIo) {
		this.#directory = directory;
		this.#io = io;
	}

	async lookup(generation: string): Promise<ExportPublicationReceipt | null> {
		if (!safeGenerationName(generation)) throw new Error("Unsafe export receipt generation");
		const receiptPath = path.join(this.#directory, `${generation}.json`);
		if (!(await pathExists(receiptPath, this.#io))) return null;
		const receipt = JSON.parse(await this.#io.readText(receiptPath)) as ExportPublicationReceipt;
		if (
			receipt.generation !== generation ||
			typeof receipt.manifestChecksum !== "string" ||
			typeof receipt.publishedPath !== "string" ||
			typeof receipt.publishedAt !== "string" ||
			receipt.receiptChecksum !== checksumJobJson(receiptBody(receipt))
		) {
			throw new Error(`Export receipt checksum mismatch for ${generation}`);
		}
		return receipt;
	}

	async record(receipt: ExportPublicationReceipt): Promise<void> {
		if (!safeGenerationName(receipt.generation)) throw new Error("Unsafe export receipt generation");
		if (receipt.receiptChecksum !== checksumJobJson(receiptBody(receipt))) {
			throw new Error(`Refusing invalid export receipt ${receipt.generation}`);
		}
		const existing = await this.lookup(receipt.generation);
		if (existing) {
			if (existing.manifestChecksum !== receipt.manifestChecksum) {
				throw new Error(`Receipt collision for export generation ${receipt.generation}`);
			}
			return;
		}
		await writeJsonAtomicDurable(path.join(this.#directory, `${receipt.generation}.json`), receipt, this.#io);
	}
}

export type ExportKillPoint = "after-file" | "after-manifest" | "after-validation" | "after-publish" | "after-receipt";

function safeGenerationName(generation: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(generation) && generation !== "." && generation !== "..";
}

function safeRelativePath(relativePath: string): boolean {
	if (relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath.includes("\\")) return false;
	const normalized = path.posix.normalize(relativePath);
	return normalized === relativePath && !normalized.startsWith("../") && normalized !== "..";
}

async function* contentChunks(content: ExportGenerationFile["content"]): AsyncIterable<Uint8Array> {
	if (typeof content === "string") {
		yield new TextEncoder().encode(content);
		return;
	}
	if (content instanceof Uint8Array) {
		yield content;
		return;
	}
	for await (const chunk of content) yield chunk;
}

async function writeExportFile(filePath: string, content: ExportGenerationFile["content"]): Promise<ExportManifestFile> {
	const handle = await fs.open(filePath, "wx", 0o600);
	const hasher = new Bun.CryptoHasher("sha256");
	let byteLength = 0;
	try {
		for await (const chunk of contentChunks(content)) {
			if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) continue;
			hasher.update(chunk);
			let offset = 0;
			while (offset < chunk.byteLength) {
				const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, byteLength + offset);
				if (bytesWritten <= 0) throw new Error(`Short write while exporting ${filePath}`);
				offset += bytesWritten;
			}
			byteLength += chunk.byteLength;
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
	return { path: "", byteLength, sha256: hasher.digest("hex") };
}

function manifestBody(manifest: Omit<ExportGenerationManifest, "manifestChecksum">): JobJson {
	return {
		schemaVersion: manifest.schemaVersion,
		generation: manifest.generation,
		publication: manifest.publication,
		cutoffs: manifest.cutoffs.map(cutoff => ({
			originId: cutoff.originId,
			branchId: cutoff.branchId,
			versionId: cutoff.versionId,
			headHash: cutoff.headHash,
		})),
		files: manifest.files.map(file => ({ path: file.path, byteLength: file.byteLength, sha256: file.sha256 })),
		totalBytes: manifest.totalBytes,
		createdAt: manifest.createdAt,
	};
}

async function hashFile(filePath: string): Promise<{ byteLength: number; sha256: string }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let byteLength = 0;
	for await (const chunk of Bun.file(filePath).stream()) {
		hasher.update(chunk);
		byteLength += chunk.byteLength;
	}
	return { byteLength, sha256: hasher.digest("hex") };
}

async function parseAndVerifyManifest(directory: string, io: DurableIo): Promise<ExportGenerationManifest> {
	const raw = JSON.parse(await io.readText(path.join(directory, "manifest.json"))) as unknown;
	if (!raw || typeof raw !== "object") throw new Error("Export manifest is not an object");
	const manifest = raw as Partial<ExportGenerationManifest>;
	if (
		manifest.schemaVersion !== 1 ||
		typeof manifest.generation !== "string" ||
		(manifest.publication !== "same-filesystem" && manifest.publication !== "cross-filesystem") ||
		!Array.isArray(manifest.cutoffs) ||
		!Array.isArray(manifest.files) ||
		typeof manifest.totalBytes !== "number" ||
		typeof manifest.createdAt !== "string" ||
		typeof manifest.manifestChecksum !== "string"
	) {
		throw new Error("Export manifest has an invalid shape");
	}
	const complete = manifest as ExportGenerationManifest;
	const body = manifestBody({
		schemaVersion: complete.schemaVersion,
		generation: complete.generation,
		publication: complete.publication,
		cutoffs: complete.cutoffs,
		files: complete.files,
		totalBytes: complete.totalBytes,
		createdAt: complete.createdAt,
	});
	if (checksumJobJson(body) !== complete.manifestChecksum) throw new Error("Export manifest checksum mismatch");
	if (!safeGenerationName(complete.generation)) throw new Error("Export manifest has an unsafe generation");
	let totalBytes = 0;
	const manifestPaths = new Set<string>();
	for (const entry of complete.files) {
		if (
			!entry ||
			typeof entry.path !== "string" ||
			!safeRelativePath(entry.path) ||
			!Number.isSafeInteger(entry.byteLength) ||
			entry.byteLength < 0 ||
			typeof entry.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(entry.sha256)
		) {
			throw new Error(`Invalid export manifest entry ${String(entry?.path)}`);
		}
		if (manifestPaths.has(entry.path)) throw new Error(`Duplicate export manifest entry ${entry.path}`);
		manifestPaths.add(entry.path);
		const observed = await hashFile(path.join(directory, entry.path));
		if (observed.byteLength !== entry.byteLength || observed.sha256 !== entry.sha256) {
			throw new Error(`Export file checksum mismatch for ${entry.path}`);
		}
		totalBytes += entry.byteLength;
	}
	if (totalBytes !== complete.totalBytes) throw new Error("Export manifest byte total mismatch");
	if (complete.publication === "cross-filesystem") {
		const marker = JSON.parse(await io.readText(path.join(directory, "COMPLETE.json"))) as {
			generation?: unknown;
			manifestChecksum?: unknown;
			checksum?: unknown;
		};
		const markerBody = { generation: complete.generation, manifestChecksum: complete.manifestChecksum };
		if (
			marker.generation !== complete.generation ||
			marker.manifestChecksum !== complete.manifestChecksum ||
			marker.checksum !== checksumJobJson(markerBody)
		) {
			throw new Error("Cross-filesystem completion marker is corrupt");
		}
	}
	return complete;
}

function createReceipt(manifest: ExportGenerationManifest, publishedPath: string, publishedAt: string): ExportPublicationReceipt {
	const body = {
		generation: manifest.generation,
		manifestChecksum: manifest.manifestChecksum,
		publishedPath,
		publishedAt,
	};
	return { ...body, receiptChecksum: checksumJobJson(receiptBody(body)) };
}

export async function repairPublicationReceipt(options: {
	publishedPath: string;
	receipts: ExportReceiptStore;
	validate?: (publishedPath: string, manifest: ExportGenerationManifest) => Promise<void>;
	io?: DurableIo;
	now?: () => string;
}): Promise<ExportPublicationReceipt> {
	const io = options.io ?? durableIo;
	const manifest = await parseAndVerifyManifest(options.publishedPath, io);
	await options.validate?.(options.publishedPath, manifest);
	const existing = await options.receipts.lookup(manifest.generation);
	if (existing) {
		if (existing.manifestChecksum !== manifest.manifestChecksum) {
			throw new Error(`Receipt collision for export generation ${manifest.generation}`);
		}
		return existing;
	}
	const receipt = createReceipt(manifest, options.publishedPath, (options.now ?? (() => new Date().toISOString()))());
	await options.receipts.record(receipt);
	return receipt;
}

export async function publishExportGeneration(options: {
	root: string;
	generation: string;
	publication: "same-filesystem" | "cross-filesystem";
	cutoffs: readonly ExportCutoff[];
	files: AsyncIterable<ExportGenerationFile>;
	receipts: ExportReceiptStore;
	validate: (temporaryPath: string, manifest: ExportGenerationManifest) => Promise<void>;
	io?: DurableIo;
	now?: () => string;
	fault?: (point: ExportKillPoint, detail?: string) => Promise<void>;
	writeEntry?: (filePath: string, content: ExportGenerationFile["content"]) => Promise<Omit<ExportManifestFile, "path">>;
}): Promise<ExportPublicationReceipt> {
	if (!safeGenerationName(options.generation)) throw new Error("Unsafe export generation name");
	const io = options.io ?? durableIo;
	const finalPath = path.join(options.root, options.generation);
	await io.mkdir(options.root);
	if (await pathExists(finalPath, io)) {
		return repairPublicationReceipt({
			publishedPath: finalPath,
			receipts: options.receipts,
			validate: options.validate,
			io,
			now: options.now,
		});
	}

	const temporaryPath = path.join(options.root, `.${options.generation}.${crypto.randomUUID()}.tmp`);
	await io.mkdir(temporaryPath);
	const files: ExportManifestFile[] = [];
	const seen = new Set<string>();
	const directories = new Set<string>([temporaryPath]);
	try {
		for await (const file of options.files) {
			if (!safeRelativePath(file.relativePath) || file.relativePath === "manifest.json" || file.relativePath === "COMPLETE.json") {
				throw new Error(`Unsafe or reserved export path ${file.relativePath}`);
			}
			if (seen.has(file.relativePath)) throw new Error(`Duplicate export path ${file.relativePath}`);
			seen.add(file.relativePath);
			const destination = path.join(temporaryPath, file.relativePath);
			const directory = path.dirname(destination);
			await io.mkdir(directory);
			directories.add(directory);
			const observed = options.writeEntry
				? await options.writeEntry(destination, file.content)
				: await writeExportFile(destination, file.content);
			files.push({ path: file.relativePath, byteLength: observed.byteLength, sha256: observed.sha256 });
			await options.fault?.("after-file", file.relativePath);
		}
		const createdAt = (options.now ?? (() => new Date().toISOString()))();
		const body = {
			schemaVersion: 1 as const,
			generation: options.generation,
			publication: options.publication,
			cutoffs: [...options.cutoffs],
			files,
			totalBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
			createdAt,
		};
		const manifest: ExportGenerationManifest = { ...body, manifestChecksum: checksumJobJson(manifestBody(body)) };
		await io.writeFile(path.join(temporaryPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		await options.fault?.("after-manifest");
		if (options.publication === "cross-filesystem") {
			const markerBody = { generation: manifest.generation, manifestChecksum: manifest.manifestChecksum };
			await io.writeFile(
				path.join(temporaryPath, "COMPLETE.json"),
				`${JSON.stringify({ ...markerBody, checksum: checksumJobJson(markerBody) }, null, 2)}\n`,
			);
		}
		for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
			await io.fsyncDirectory(directory);
		}
		await parseAndVerifyManifest(temporaryPath, io);
		await options.validate(temporaryPath, manifest);
		await options.fault?.("after-validation");
		await io.rename(temporaryPath, finalPath);
		await io.fsyncDirectory(options.root);
		await options.fault?.("after-publish");
		const receipt = createReceipt(manifest, finalPath, (options.now ?? (() => new Date().toISOString()))());
		await options.receipts.record(receipt);
		await options.fault?.("after-receipt");
		return receipt;
	} catch (error) {
		if (!(await pathExists(finalPath, io))) await io.remove(temporaryPath, true).catch(() => undefined);
		throw error;
	}
}

