import { checksumJobJson } from "./checksum";
import { DurableJobJournal, jobCommitId } from "./journal";

export interface ByteBoundedJobItem<T> {
	cursor: string;
	nextCursor: string;
	byteLength: number;
	contentChecksum: string;
	value: T;
}

export interface DurableBatchReceipt {
	commitId: string;
	effectChecksum: string;
	receiptChecksum: string;
}

export interface DurableBatchExecutor<T> {
	lookupReceipt(commitId: string): Promise<DurableBatchReceipt | null>;
	commit(
		items: readonly ByteBoundedJobItem<T>[],
		context: { commitId: string; effectChecksum: string },
	): Promise<DurableBatchReceipt>;
}

function batchEffectChecksum<T>(items: readonly ByteBoundedJobItem<T>[]): string {
	return checksumJobJson(
		items.map(item => ({
			cursor: item.cursor,
			nextCursor: item.nextCursor,
			byteLength: item.byteLength,
			contentChecksum: item.contentChecksum,
		})),
	);
}

function validateReceipt(
	receipt: DurableBatchReceipt,
	expectedCommitId: string,
	expectedEffectChecksum: string,
): void {
	if (receipt.commitId !== expectedCommitId || receipt.effectChecksum !== expectedEffectChecksum) {
		throw new Error(`Durable receipt does not acknowledge commit ${expectedCommitId}`);
	}
	if (!/^[a-f0-9]{64}$/.test(receipt.receiptChecksum)) {
		throw new Error(`Durable receipt ${expectedCommitId} has an invalid checksum`);
	}
}

function isCancellationRequested(journal: DurableJobJournal): boolean {
	return journal.snapshot.phase === "cancel-requested";
}

export interface ByteBoundedRunResult {
	state: "completed" | "cancelled";
	commits: number;
	committedBytes: number;
	recoveredReceipts: number;
}

/** Runs only whole items and never acknowledges a cursor before the executor's durable receipt. */
export async function runByteBoundedJob<T>(options: {
	journal: DurableJobJournal;
	itemsFrom(cursor: string): AsyncIterable<ByteBoundedJobItem<T>>;
	executor: DurableBatchExecutor<T>;
}): Promise<ByteBoundedRunResult> {
	let snapshot = options.journal.snapshot;
	if (snapshot.phase === "cancel-requested") {
		await options.journal.markCancelled();
		return {
			state: "cancelled",
			commits: snapshot.commits.length,
			committedBytes: snapshot.committedBytes,
			recoveredReceipts: 0,
		};
	}
	await options.journal.start();
	snapshot = options.journal.snapshot;
	let cursor = snapshot.nextCursor;
	let batch: ByteBoundedJobItem<T>[] = [];
	let batchBytes = 0;
	let recoveredReceipts = 0;

	const flushBatch = async (): Promise<void> => {
		if (batch.length === 0) return;
		const effectChecksum = batchEffectChecksum(batch);
		const endCursor = batch.at(-1)!.nextCursor;
		const commitId = jobCommitId(snapshot.jobId, cursor, endCursor, effectChecksum);
		let receipt = await options.executor.lookupReceipt(commitId);
		if (receipt) {
			recoveredReceipts += 1;
		} else {
			receipt = await options.executor.commit(batch, { commitId, effectChecksum });
		}
		validateReceipt(receipt, commitId, effectChecksum);
		await options.journal.appendCommit({
			commitId,
			startCursor: cursor,
			endCursor,
			byteCount: batchBytes,
			effectChecksum,
			receiptChecksum: receipt.receiptChecksum,
		});
		cursor = endCursor;
		batch = [];
		batchBytes = 0;
		snapshot = options.journal.snapshot;
	};

	const finishCancellation = async (): Promise<ByteBoundedRunResult> => {
		await flushBatch();
		await options.journal.markCancelled();
		const cancelled = options.journal.snapshot;
		return {
			state: "cancelled",
			commits: cancelled.commits.length,
			committedBytes: cancelled.committedBytes,
			recoveredReceipts,
		};
	};

	for await (const item of options.itemsFrom(cursor)) {
		if (isCancellationRequested(options.journal)) return finishCancellation();
		if (!Number.isSafeInteger(item.byteLength) || item.byteLength <= 0) {
			throw new Error(`Invalid byte length at cursor ${item.cursor}`);
		}
		if (item.byteLength > snapshot.byteLimit) {
			throw new Error(`Item at cursor ${item.cursor} exceeds job byte limit and must be streamed or quarantined`);
		}
		const expectedCursor = batch.at(-1)?.nextCursor ?? cursor;
		if (item.cursor !== expectedCursor) {
			throw new Error(`Input cursor gap: expected ${expectedCursor}, received ${item.cursor}`);
		}
		if (batchBytes + item.byteLength > snapshot.byteLimit) {
			await flushBatch();
			if (isCancellationRequested(options.journal)) return finishCancellation();
		}
		batch.push(item);
		batchBytes += item.byteLength;
	}
	await flushBatch();
	if (isCancellationRequested(options.journal)) return finishCancellation();
	await options.journal.markCompleted();
	const completed = options.journal.snapshot;
	return {
		state: "completed",
		commits: completed.commits.length,
		committedBytes: completed.committedBytes,
		recoveredReceipts,
	};
}
