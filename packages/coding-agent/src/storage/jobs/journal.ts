import * as path from "node:path";
import { checksumJobJson, type JobJson } from "./checksum";
import { durableIo, type DurableIo, pathExists, writeJsonAtomicDurable } from "./durable-fs";

export type StorageJobKind = "import" | "export" | "sync";
export type StorageJobPhase = "prepared" | "running" | "cancel-requested" | "cancelled" | "completed";

export interface JobCommit {
	sequence: number;
	commitId: string;
	previousChecksum: string | null;
	startCursor: string;
	endCursor: string;
	byteCount: number;
	effectChecksum: string;
	receiptChecksum: string;
	committedAt: string;
	checksum: string;
}

export interface StorageJobSnapshot {
	schemaVersion: 1;
	jobId: string;
	kind: StorageJobKind;
	phase: StorageJobPhase;
	byteLimit: number;
	nextCursor: string;
	committedBytes: number;
	commits: JobCommit[];
	createdAt: string;
	updatedAt: string;
	stateChecksum: string;
}

export interface PendingJobCommit {
	commitId: string;
	startCursor: string;
	endCursor: string;
	byteCount: number;
	effectChecksum: string;
	receiptChecksum: string;
}

interface SnapshotBody {
	schemaVersion: 1;
	jobId: string;
	kind: StorageJobKind;
	phase: StorageJobPhase;
	byteLimit: number;
	nextCursor: string;
	committedBytes: number;
	commits: JobCommit[];
	createdAt: string;
	updatedAt: string;
}

function commitBody(commit: Omit<JobCommit, "checksum">): JobJson {
	return {
		sequence: commit.sequence,
		commitId: commit.commitId,
		previousChecksum: commit.previousChecksum,
		startCursor: commit.startCursor,
		endCursor: commit.endCursor,
		byteCount: commit.byteCount,
		effectChecksum: commit.effectChecksum,
		receiptChecksum: commit.receiptChecksum,
		committedAt: commit.committedAt,
	};
}

function snapshotBody(snapshot: StorageJobSnapshot): SnapshotBody {
	return {
		schemaVersion: snapshot.schemaVersion,
		jobId: snapshot.jobId,
		kind: snapshot.kind,
		phase: snapshot.phase,
		byteLimit: snapshot.byteLimit,
		nextCursor: snapshot.nextCursor,
		committedBytes: snapshot.committedBytes,
		commits: snapshot.commits,
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
	};
}

function checksumSnapshot(body: SnapshotBody): string {
	return checksumJobJson(body as unknown as JobJson);
}

function validateSnapshot(input: unknown): StorageJobSnapshot {
	if (!input || typeof input !== "object") throw new Error("Job journal is not an object");
	const value = input as Partial<StorageJobSnapshot>;
	if (
		value.schemaVersion !== 1 ||
		typeof value.jobId !== "string" ||
		(value.kind !== "import" && value.kind !== "export" && value.kind !== "sync") ||
		(value.phase !== "prepared" &&
			value.phase !== "running" &&
			value.phase !== "cancel-requested" &&
			value.phase !== "cancelled" &&
			value.phase !== "completed") ||
		typeof value.byteLimit !== "number" ||
		!Number.isSafeInteger(value.byteLimit) ||
		value.byteLimit <= 0 ||
		typeof value.nextCursor !== "string" ||
		typeof value.committedBytes !== "number" ||
		!Number.isSafeInteger(value.committedBytes) ||
		!Array.isArray(value.commits) ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string" ||
		typeof value.stateChecksum !== "string"
	) {
		throw new Error("Job journal has an invalid shape");
	}
	const snapshot = value as StorageJobSnapshot;
	if (checksumSnapshot(snapshotBody(snapshot)) !== snapshot.stateChecksum) {
		throw new Error(`Job journal checksum mismatch for ${snapshot.jobId}`);
	}
	let expectedCursor = "";
	let expectedPrevious: string | null = null;
	let totalBytes = 0;
	for (const [index, commit] of snapshot.commits.entries()) {
		if (
			commit.sequence !== index ||
			commit.previousChecksum !== expectedPrevious ||
			commit.startCursor !== expectedCursor ||
			commit.byteCount <= 0 ||
			commit.byteCount > snapshot.byteLimit ||
			checksumJobJson(commitBody(commit)) !== commit.checksum
		) {
			throw new Error(`Job journal commit chain is corrupt at sequence ${index}`);
		}
		expectedCursor = commit.endCursor;
		expectedPrevious = commit.checksum;
		totalBytes += commit.byteCount;
	}
	if (snapshot.nextCursor !== expectedCursor || snapshot.committedBytes !== totalBytes) {
		throw new Error(`Job journal cursor or byte total is corrupt for ${snapshot.jobId}`);
	}
	return snapshot;
}

export function jobCommitId(jobId: string, startCursor: string, endCursor: string, effectChecksum: string): string {
	return checksumJobJson({ jobId, startCursor, endCursor, effectChecksum });
}

export class DurableJobJournal {
	readonly #directory: string;
	readonly #io: DurableIo;
	#snapshot: StorageJobSnapshot;

	private constructor(directory: string, snapshot: StorageJobSnapshot, io: DurableIo) {
		this.#directory = directory;
		this.#snapshot = snapshot;
		this.#io = io;
	}

	static async create(
		directory: string,
		options: { jobId: string; kind: StorageJobKind; byteLimit: number; now?: () => string; io?: DurableIo },
	): Promise<DurableJobJournal> {
		if (!Number.isSafeInteger(options.byteLimit) || options.byteLimit <= 0) {
			throw new Error("Job byte limit must be a positive safe integer");
		}
		const io = options.io ?? durableIo;
		const statePath = path.join(directory, "state.json");
		if (await pathExists(statePath, io)) return DurableJobJournal.open(directory, io);
		const timestamp = (options.now ?? (() => new Date().toISOString()))();
		const body: SnapshotBody = {
			schemaVersion: 1,
			jobId: options.jobId,
			kind: options.kind,
			phase: "prepared",
			byteLimit: options.byteLimit,
			nextCursor: "",
			committedBytes: 0,
			commits: [],
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const snapshot: StorageJobSnapshot = { ...body, stateChecksum: checksumSnapshot(body) };
		await writeJsonAtomicDurable(statePath, snapshot, io);
		return new DurableJobJournal(directory, snapshot, io);
	}

	static async open(directory: string, io: DurableIo = durableIo): Promise<DurableJobJournal> {
		const text = await io.readText(path.join(directory, "state.json"));
		const snapshot = validateSnapshot(JSON.parse(text) as unknown);
		return new DurableJobJournal(directory, snapshot, io);
	}

	get snapshot(): StorageJobSnapshot {
		return structuredClone(this.#snapshot);
	}

	async start(now: () => string = () => new Date().toISOString()): Promise<void> {
		if (this.#snapshot.phase === "completed" || this.#snapshot.phase === "cancelled") {
			throw new Error(`Cannot resume terminal job ${this.#snapshot.jobId}`);
		}
		await this.#setPhase("running", now());
	}

	async requestCancel(now: () => string = () => new Date().toISOString()): Promise<void> {
		if (this.#snapshot.phase === "completed" || this.#snapshot.phase === "cancelled") return;
		await this.#setPhase("cancel-requested", now());
	}

	async markCancelled(now: () => string = () => new Date().toISOString()): Promise<void> {
		if (this.#snapshot.phase !== "cancel-requested") throw new Error("Job cancellation was not requested");
		await this.#setPhase("cancelled", now());
	}

	async markCompleted(now: () => string = () => new Date().toISOString()): Promise<void> {
		if (this.#snapshot.phase !== "running") throw new Error("Only a running job can complete");
		await this.#setPhase("completed", now());
	}

	async appendCommit(commit: PendingJobCommit, now: () => string = () => new Date().toISOString()): Promise<void> {
		if (this.#snapshot.phase !== "running" && this.#snapshot.phase !== "cancel-requested") {
			throw new Error("Only a running or cancel-requested job can append its current batch");
		}
		if (commit.startCursor !== this.#snapshot.nextCursor) {
			throw new Error(`Commit cursor ${commit.startCursor} does not match durable cursor ${this.#snapshot.nextCursor}`);
		}
		if (!Number.isSafeInteger(commit.byteCount) || commit.byteCount <= 0 || commit.byteCount > this.#snapshot.byteLimit) {
			throw new Error(`Commit exceeds byte limit for ${this.#snapshot.jobId}`);
		}
		const previous = this.#snapshot.commits.at(-1)?.checksum ?? null;
		const committedAt = now();
		const body = {
			sequence: this.#snapshot.commits.length,
			commitId: commit.commitId,
			previousChecksum: previous,
			startCursor: commit.startCursor,
			endCursor: commit.endCursor,
			byteCount: commit.byteCount,
			effectChecksum: commit.effectChecksum,
			receiptChecksum: commit.receiptChecksum,
			committedAt,
		};
		const entry: JobCommit = { ...body, checksum: checksumJobJson(commitBody(body)) };
		const nextBody: SnapshotBody = {
			...snapshotBody(this.#snapshot),
			nextCursor: commit.endCursor,
			committedBytes: this.#snapshot.committedBytes + commit.byteCount,
			commits: [...this.#snapshot.commits, entry],
			updatedAt: committedAt,
		};
		await this.#persist(nextBody);
	}

	async #setPhase(phase: StorageJobPhase, timestamp: string): Promise<void> {
		await this.#persist({ ...snapshotBody(this.#snapshot), phase, updatedAt: timestamp });
	}

	async #persist(body: SnapshotBody): Promise<void> {
		const snapshot: StorageJobSnapshot = { ...body, stateChecksum: checksumSnapshot(body) };
		await writeJsonAtomicDurable(path.join(this.#directory, "state.json"), snapshot, this.#io);
		this.#snapshot = snapshot;
	}
}
