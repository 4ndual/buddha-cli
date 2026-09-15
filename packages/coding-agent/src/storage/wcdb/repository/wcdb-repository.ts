import type {
	AppendSessionRequest,
	AppendSessionResult,
	ArchiveExport,
	ArchiveExportRequest,
	ArchiveImportRequest,
	ArchiveManifest,
	BackupReceipt,
	BackupRequest,
	BranchId,
	ContextTail,
	ContextTailRequest,
	FlushRequest,
	ForkSessionRequest,
	ForkSessionResult,
	IntegrityReport,
	Page,
	PayloadChunk,
	PayloadStreamRequest,
	RepositoryCapabilities,
	RepositoryHealth,
	ReplicaId,
	RepositorySessionHeader,
	SessionListQuery,
	SessionRepository,
	SessionSearchHit,
	SessionSearchQuery,
	SessionTreeEvent,
	SessionTreeQuery,
	StorageJobControl,
	StorageTransferPreview,
	StorageTransferReport,
	WriteContextCheckpointRequest,
} from "../../contracts";
import { boundPageRequest, decodePageCursor, encodePageCursor } from "../../contracts";
import { canonicalBytes } from "../../identity";
import { WcdbWorkerClient, type WcdbRequestOptions, type WcdbWorkerClientOptions } from "../worker/client";
import {
	bigintFromInt64,
	type WcdbBatchResult,
	type WcdbInt64,
	type WcdbKeyset,
	type WcdbOpenOptions,
	type WcdbRecord,
	type WcdbValue,
} from "../worker/protocol";

const DEFAULT_IMPORT_BATCH_BYTES = 6 * 1024 * 1024;
const MAX_IMPORT_BATCH_BYTES = 6 * 1024 * 1024;
const PAYLOAD_PAGE_CHUNKS = 64;
const EXPORT_PAGE_CHUNKS = 64;
const DOCUMENT_COLUMN = "document";
type EncodedDocument =
	| readonly ["null"]
	| readonly ["undefined"]
	| readonly ["boolean", boolean]
	| readonly ["number", string]
	| readonly ["string", string]
	| readonly ["bigint", string]
	| readonly ["binary", string]
	| readonly ["array", readonly (EncodedDocument | readonly ["hole"])[]]
	| readonly ["object", readonly (readonly [string, EncodedDocument])[]];

export interface WcdbSessionRepositoryOptions extends WcdbOpenOptions {
	readonly mode: "db";
	readonly replicaId: ReplicaId;
	readonly client?: WcdbWorkerClientOptions;
}

function encodeDocumentValue(value: unknown): EncodedDocument {
	if (value === null) return ["null"];
	switch (typeof value) {
		case "undefined":
			return ["undefined"];
		case "boolean":
			return ["boolean", value];
		case "number":
			return ["number", Object.is(value, -0) ? "-0" : String(value)];
		case "string":
			return ["string", value];
		case "bigint":
			return ["bigint", value.toString()];
		case "object": {
			if (value instanceof ArrayBuffer) return ["binary", Buffer.from(value).toString("base64")];
			if (ArrayBuffer.isView(value)) {
				return ["binary", Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")];
			}
			if (Array.isArray(value)) {
				const items: (EncodedDocument | readonly ["hole"])[] = [];
				for (let index = 0; index < value.length; index++) {
					items.push(Object.hasOwn(value, index) ? encodeDocumentValue(value[index]) : ["hole"]);
				}
				return ["array", items];
			}
			return ["object", Object.entries(value).map(([key, item]) => [key, encodeDocumentValue(item)] as const)];
		}
		default:
			throw new TypeError(`WCDB document contains unsupported ${typeof value}`);
	}
}

function decodeDocumentValue(value: EncodedDocument | readonly ["hole"]): unknown {
	switch (value[0]) {
		case "null":
			return null;
		case "undefined":
			return undefined;
		case "boolean":
		case "string":
			return value[1];
		case "number":
			return value[1] === "-0" ? -0 : Number(value[1]);
		case "bigint":
			return BigInt(value[1]);
		case "binary":
			return new Uint8Array(Buffer.from(value[1], "base64"));
		case "array": {
			const decoded: unknown[] = [];
			for (const item of value[1]) {
				if (item[0] === "hole") decoded.length++;
				else decoded.push(decodeDocumentValue(item));
			}
			return decoded;
		}
		case "object": {
			const decoded: Record<string, unknown> = {};
			for (const [key, item] of value[1]) {
				Object.defineProperty(decoded, key, {
					value: decodeDocumentValue(item),
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			return decoded;
		}
		case "hole":
			throw new Error("WCDB document contains a hole outside an array");
	}
}

export function encodeRepositoryDocument(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(encodeDocumentValue(value)));
}

export function decodeRepositoryDocument<T>(value: WcdbValue | undefined, label: string): T {
	let text: string;
	if (typeof value === "string") text = value;
	else if (value instanceof Uint8Array) text = new TextDecoder().decode(value);
	else throw new Error(`WCDB ${label} result is missing its document column`);
	return decodeDocumentValue(JSON.parse(text) as EncodedDocument) as T;
}

function decodeRow<T>(row: WcdbRecord | undefined, label: string): T {
	if (!row) throw new Error(`WCDB ${label} returned no row`);
	return decodeRepositoryDocument<T>(row[DOCUMENT_COLUMN], label);
}

function cursorToKeyset(cursor: string | undefined): WcdbKeyset | undefined {
	if (!cursor) return undefined;
	const fields = decodePageCursor(cursor);
	return { values: Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value) };
}

function keysetToCursor(keyset: WcdbKeyset | undefined): string | undefined {
	if (!keyset) return undefined;
	const fields: Record<string, string | number | boolean | null> = {};
	for (let index = 0; index < keyset.values.length; index++) {
		const value = keyset.values[index];
		if (value instanceof Uint8Array) throw new Error("WCDB keyset cursor cannot contain binary values");
		fields[`k${index.toString().padStart(3, "0")}`] =
			typeof value === "object" && value !== null && "type" in value ? value.decimal : value;
	}
	return encodePageCursor(fields);
}

function pageFromResult<T>(result: WcdbBatchResult, label: string): Page<T> {
	return {
		items: result.rows.map(row => decodeRepositoryDocument<T>(row[DOCUMENT_COLUMN], label)),
		...(result.next ? { nextCursor: keysetToCursor(result.next) } : {}),
	};
}

function requestOptions(signal?: AbortSignal): WcdbRequestOptions {
	return signal ? { signal } : {};
}

function chunkOffset(value: WcdbValue | undefined): number {
	const bigint = typeof value === "object" && value !== null && "type" in value ? bigintFromInt64(value) : BigInt(String(value));
	const number = Number(bigint);
	if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`WCDB payload offset is outside JavaScript safe range: ${bigint}`);
	return number;
}

/**
 * WCDB implementation of the storage-domain repository. Every method issues a
 * bounded batch request to the dedicated worker; this module never imports a
 * session JSONL path, scanner, or filesystem storage adapter.
 */
export class WcdbSessionRepository implements SessionRepository {
	readonly mode = "db" as const;
	readonly replicaId: ReplicaId;
	readonly #client: WcdbWorkerClient;
	#closed = false;

	private constructor(replicaId: ReplicaId, client: WcdbWorkerClient) {
		this.replicaId = replicaId;
		this.#client = client;
	}

	static async open(options: WcdbSessionRepositoryOptions): Promise<WcdbSessionRepository> {
		if (options.mode !== "db") throw new Error("WcdbSessionRepository can only be opened in explicit db mode");
		const client = await WcdbWorkerClient.open(
			{
				databasePath: options.databasePath,
				readPoolSize: options.readPoolSize,
				nativeLibraryPath: options.nativeLibraryPath,
				busyTimeoutMs: options.busyTimeoutMs,
				maxQueuedBytes: options.maxQueuedBytes,
				maxRequestBytes: options.maxRequestBytes,
			},
			options.client,
		);
		return new WcdbSessionRepository(options.replicaId, client);
	}

	async capabilities(): Promise<RepositoryCapabilities> {
		return (await this.health()).capabilities;
	}

	async listSessions(query: SessionListQuery = {}): Promise<Page<RepositorySessionHeader>> {
		this.#assertOpen();
		const bounded = boundPageRequest(query);
		const result = await this.#client.execute({
			kind: "list",
			request: encodeRepositoryDocument({ ...query, cursor: undefined, limit: undefined }),
			limit: bounded.limit,
			after: cursorToKeyset(bounded.cursor),
		});
		return pageFromResult<RepositorySessionHeader>(result, "session list");
	}

	async searchSessions(query: SessionSearchQuery): Promise<Page<SessionSearchHit>> {
		this.#assertOpen();
		const bounded = boundPageRequest(query);
		const result = await this.#client.execute({
			kind: "search",
			request: encodeRepositoryDocument({ ...query, cursor: undefined, limit: undefined }),
			limit: bounded.limit,
			after: cursorToKeyset(bounded.cursor),
		});
		return pageFromResult<SessionSearchHit>(result, "session search");
	}

	async listTree(query: SessionTreeQuery): Promise<Page<SessionTreeEvent>> {
		this.#assertOpen();
		const bounded = boundPageRequest(query);
		const result = await this.#client.execute({
			kind: "read-tree",
			request: encodeRepositoryDocument({ ...query, cursor: undefined, limit: undefined }),
			limit: bounded.limit,
			after: cursorToKeyset(bounded.cursor),
		});
		return pageFromResult<SessionTreeEvent>(result, "session tree");
	}

	async getHeader(branchId: BranchId): Promise<RepositorySessionHeader | undefined> {
		this.#assertOpen();
		const result = await this.#client.execute({ kind: "get-header", branchId });
		if (result.rows.length === 0) return undefined;
		return decodeRow<RepositorySessionHeader>(result.rows[0], "session header");
	}

	async append(request: AppendSessionRequest): Promise<AppendSessionResult> {
		this.#assertOpen();
		const result = await this.#client.execute({
			kind: "append",
			branchId: request.branchId,
			expectedHeadHash: request.expectedHeadHash,
			events: [
				{
					operation_id: request.operationId,
					replica_id: request.replicaId,
					source_alias: request.sourceAlias ?? null,
					entry: encodeRepositoryDocument(request.entry),
					entry_canonical: canonicalBytes(request.entry),
				},
			],
			payloads: [],
		});
		return decodeRow<AppendSessionResult>(result.rows[0], "append");
	}

	async fork(request: ForkSessionRequest): Promise<ForkSessionResult> {
		this.#assertOpen();
		const result = await this.#client.execute({ kind: "fork", request: encodeRepositoryDocument(request) });
		return decodeRow<ForkSessionResult>(result.rows[0], "fork");
	}

	async writeContextCheckpoint(request: WriteContextCheckpointRequest): Promise<void> {
		this.#assertOpen();
		await this.#client.execute({ kind: "write-checkpoint", request: encodeRepositoryDocument(request) });
	}

	async readContextTail(request: ContextTailRequest): Promise<ContextTail> {
		this.#assertOpen();
		const result = await this.#client.execute({ kind: "read-context-tail", request: encodeRepositoryDocument(request) });
		return decodeRow<ContextTail>(result.rows[0], "context tail");
	}

	async *streamPayload(request: PayloadStreamRequest): AsyncIterable<PayloadChunk> {
		this.#assertOpen();
		let afterChunk: WcdbInt64 | undefined;
		do {
			const result = await this.#client.execute({
				kind: "read-payload-chunks",
				request: encodeRepositoryDocument(request),
				limit: PAYLOAD_PAGE_CHUNKS,
				afterChunk,
			});
			for (const row of result.rows) {
				const bytes = row.bytes;
				if (!(bytes instanceof Uint8Array)) throw new Error("WCDB payload chunk is missing binary bytes");
				const payloadId = row.payload_id;
				const contentHash = row.content_hash;
				const codec = row.codec;
				if (typeof payloadId !== "string" || typeof contentHash !== "string" || typeof codec !== "string") {
					throw new Error("WCDB payload chunk metadata is malformed");
				}
				yield {
					payloadId,
					offset: chunkOffset(row.offset),
					bytes,
					final: row.final === true,
					contentHash,
					totalLength: chunkOffset(row.total_length),
					codec,
				};
			}
			const next = result.next?.values[0];
			afterChunk = typeof next === "object" && next !== null && "type" in next ? next : undefined;
			if (result.rows.length === 0) afterChunk = undefined;
		} while (afterChunk);
	}

	async previewImport(request: ArchiveImportRequest): Promise<StorageTransferPreview> {
		return (await this.#consumeImport(request, true, true)) as StorageTransferPreview;
	}

	async importArchive(request: ArchiveImportRequest): Promise<StorageTransferReport> {
		return (await this.#consumeImport(request, request.dryRun === true, false)) as StorageTransferReport;
	}

	async exportArchive(request: ArchiveExportRequest): Promise<ArchiveExport> {
		this.#assertOpen();
		const begin = await this.#client.execute(
			{
				kind: "begin-export",
				jobId: request.jobId,
				request: encodeRepositoryDocument({ jobId: request.jobId, scope: request.scope, cutoffVersionId: request.cutoffVersionId }),
			},
			requestOptions(request.signal),
		);
		const manifest = decodeRow<ArchiveManifest>(begin.rows[0], "archive export manifest");
		const client = this.#client;
		const signal = request.signal;
		const jobId = request.jobId;
		const chunks: AsyncIterable<Uint8Array> = {
			async *[Symbol.asyncIterator]() {
				let after: WcdbKeyset | undefined;
				do {
					const page = await client.execute(
						{ kind: "export-page", jobId, limit: EXPORT_PAGE_CHUNKS, after },
						requestOptions(signal),
					);
					for (const row of page.rows) {
						const bytes = row.bytes;
						if (!(bytes instanceof Uint8Array)) throw new Error("WCDB export page returned a non-binary chunk");
						yield bytes;
					}
					after = page.rows.length > 0 ? page.next : undefined;
				} while (after);
			},
		};
		return { manifest, chunks };
	}

	async getTransferJob(jobId: string): Promise<StorageTransferReport | undefined> {
		this.#assertOpen();
		const result = await this.#client.execute({ kind: "get-transfer-job", jobId });
		return result.rows.length === 0 ? undefined : decodeRow<StorageTransferReport>(result.rows[0], "transfer job");
	}

	async controlTransferJob(jobId: string, control: StorageJobControl): Promise<StorageTransferReport> {
		this.#assertOpen();
		const result = await this.#client.execute({ kind: "control-transfer-job", jobId, control });
		return decodeRow<StorageTransferReport>(result.rows[0], "transfer job control");
	}

	async verify(signal?: AbortSignal): Promise<IntegrityReport> {
		this.#assertOpen();
		const result = await this.#client.execute({ kind: "verify" }, requestOptions(signal));
		return decodeRow<IntegrityReport>(result.rows[0], "integrity verification");
	}

	async backup(request: BackupRequest): Promise<BackupReceipt> {
		this.#assertOpen();
		const result = await this.#client.execute(
			{ kind: "backup", request: encodeRepositoryDocument({ jobId: request.jobId, destination: request.destination }) },
			requestOptions(request.signal),
		);
		return decodeRow<BackupReceipt>(result.rows[0], "backup");
	}

	async flush(request: FlushRequest = {}): Promise<void> {
		this.#assertOpen();
		await this.#client.execute(
			{ kind: "flush", durability: request.durability ?? "power-loss" },
			requestOptions(request.signal),
		);
	}

	async health(): Promise<RepositoryHealth> {
		this.#assertOpen();
		const result = await this.#client.execute({ kind: "health" });
		return decodeRow<RepositoryHealth>(result.rows[0], "repository health");
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#client.close({ drain: true });
	}

	async #consumeImport(
		request: ArchiveImportRequest,
		dryRun: boolean,
		preview: boolean,
	): Promise<StorageTransferPreview | StorageTransferReport> {
		this.#assertOpen();
		const batchBytes = request.batchBytes ?? DEFAULT_IMPORT_BATCH_BYTES;
		if (!Number.isSafeInteger(batchBytes) || batchBytes < 1 || batchBytes > MAX_IMPORT_BATCH_BYTES) {
			throw new RangeError(`WCDB import batchBytes must be between 1 and ${MAX_IMPORT_BATCH_BYTES}`);
		}
		const options = requestOptions(request.signal);
		await this.#client.execute(
			{
				kind: "begin-import",
				jobId: request.jobId,
				request: encodeRepositoryDocument({
					jobId: request.jobId,
					replicaId: request.replicaId,
					sourceAlias: request.sourceAlias,
					dryRun,
					preview,
					byteLength: request.archive.byteLength,
					sha256: request.archive.sha256,
				}),
			},
			options,
		);

		let cursor = 0n;
		let chunks: Uint8Array[] = [];
		let bytes = 0;
		const commitBatch = async (final: boolean): Promise<WcdbBatchResult> => {
			const result = await this.#client.execute(
				{ kind: "import-batch", jobId: request.jobId, cursor: cursor.toString(), chunks, final },
				options,
			);
			for (const chunk of chunks) cursor += BigInt(chunk.byteLength);
			chunks = [];
			bytes = 0;
			return result;
		};

		for await (const sourceChunk of request.archive.chunks) {
			if (request.signal?.aborted) throw request.signal.reason;
			let offset = 0;
			while (offset < sourceChunk.byteLength) {
				const take = Math.min(batchBytes - bytes, sourceChunk.byteLength - offset);
				chunks.push(sourceChunk.subarray(offset, offset + take));
				bytes += take;
				offset += take;
				if (bytes === batchBytes) await commitBatch(false);
			}
		}
		const result = await commitBatch(true);
		return decodeRow<StorageTransferPreview | StorageTransferReport>(result.rows[0], "archive import");
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("WCDB repository is closed");
	}
}
