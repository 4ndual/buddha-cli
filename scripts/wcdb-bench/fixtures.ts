import type { BenchmarkRow } from "./sqlite";
import { readBenchmarkRows } from "./corpus";
import { sha256Text } from "./util";

export interface FixtureSummary {
	actualRows: number;
	scaledRows: number;
	longestEntries: number;
	forkBranches: number;
	giantOutputBytes: number;
	inputBytes: number;
}

export interface FixtureOptions {
	corpusRoot: string;
	maxInputBytes: number;
	maxRecordBytes: number;
	scale: number;
	longestEntries: number;
	forkBranches: number;
	giantOutputBytes: number;
}

function deterministicText(seed: string, bytes: number): string {
	const block = `benchmark-safe-${sha256Text(seed)} `;
	if (bytes <= block.length) return block.slice(0, bytes);
	return block.repeat(Math.ceil(bytes / block.length)).slice(0, bytes);
}

export async function produceFixtureRows(options: FixtureOptions, visit: (row: BenchmarkRow) => void | Promise<void>): Promise<FixtureSummary> {
	let actualRows = 0;
	let scaledRows = 0;
	const actual = await readBenchmarkRows(options.corpusRoot, options.maxInputBytes, options.maxRecordBytes, async row => {
		await visit(row);
		actualRows++;
		const safePayloadBytes = Math.max(64, Math.min(row.payload.byteLength, options.maxRecordBytes, 16 * 1024));
		for (let copy = 0; copy < options.scale; copy++) {
			const originId = `scaled:${copy}:${row.originId}`;
			const id = sha256Text(`${copy}\0${row.id}`);
			const parentId = row.parentId ? sha256Text(`${copy}\0${row.parentId}`) : null;
			const payloadText = deterministicText(`${copy}:${row.id}:${row.payload.byteLength}`, safePayloadBytes);
			await visit({
				id,
				originId,
				parentId,
				kind: row.kind,
				text: `benchmark deterministic safe corpus ${row.kind} ${row.payload.byteLength} ${payloadText.slice(0, 512)}`,
				payload: new TextEncoder().encode(payloadText),
			});
			scaledRows++;
		}
	});

	let previous: string | null = null;
	for (let index = 0; index < options.longestEntries; index++) {
		const id = sha256Text(`longest:${index}`);
		await visit({
			id,
			originId: "fixture:longest",
			parentId: previous,
			kind: "message",
			text: `benchmark longest session message ${index}`,
			payload: new TextEncoder().encode(deterministicText(`longest:${index}`, 256)),
		});
		previous = id;
	}

	const forkRoot = sha256Text("fork-root");
	await visit({
		id: forkRoot,
		originId: "fixture:fork-heavy",
		parentId: null,
		kind: "message",
		text: "benchmark fork root",
		payload: new TextEncoder().encode("benchmark fork root"),
	});
	for (let branch = 0; branch < options.forkBranches; branch++) {
		let branchParent = forkRoot;
		for (let depth = 0; depth < 8; depth++) {
			const id = sha256Text(`fork:${branch}:${depth}`);
			await visit({
				id,
				originId: "fixture:fork-heavy",
				parentId: branchParent,
				kind: "message",
				text: `benchmark fork branch ${branch} depth ${depth}`,
				payload: new TextEncoder().encode(deterministicText(`fork:${branch}:${depth}`, 192)),
			});
			branchParent = id;
		}
	}

	const giantBytes = Math.min(options.giantOutputBytes, options.maxRecordBytes);
	const giantText = deterministicText("giant-output", giantBytes);
	await visit({
		id: sha256Text("giant-output"),
		originId: "fixture:giant-output",
		parentId: null,
		kind: "toolResult",
		text: `benchmark giant tool result ${giantBytes} bytes`,
		payload: new TextEncoder().encode(giantText),
	});
	return {
		actualRows,
		scaledRows,
		longestEntries: options.longestEntries,
		forkBranches: options.forkBranches,
		giantOutputBytes: giantBytes,
		inputBytes: actual.bytes,
	};
}
