import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { serializeTitleSlot } from "../../../src/session/session-title-slot";
import { hasWcdbTestAdapter, type JsonValue, WcdbMigrationTestDriver } from "./migration-test-driver";

interface RepositoryObservation extends Record<string, JsonValue> {
	header: JsonValue;
	graph: JsonValue;
	selectedLeaf: string;
	toolPairs: JsonValue;
	contextMessages: JsonValue;
	contextHash: string;
	compaction: JsonValue;
	labels: JsonValue;
	custom: JsonValue;
	attachments: JsonValue;
	provenance: JsonValue;
	currentTitle: JsonValue;
	titleHistory: JsonValue;
	versionIds: JsonValue;
	branchIds: JsonValue;
	aliases: JsonValue;
	metadataRevisionIds: JsonValue;
	payloadHashes: JsonValue;
}

interface RepositoryContractProbe extends Record<string, JsonValue> {
	capabilities: { list: boolean; search: boolean; tree: boolean; checkpoint: boolean; payloadStreaming: boolean };
	firstPageIds: string[];
	secondPageIds: string[];
	searchEventIds: string[];
	treeEventIds: string[];
	headerOriginId: string;
	checkpointHeadHash: string;
	tailEventIds: string[];
	payloadChunksBase64: string[];
	flushDurable: boolean;
	health: { mode: string; ready: boolean };
}

const fixtureDir = path.resolve(import.meta.dir, "../../fixtures/wcdb");
const integrationIt = it.skipIf(!hasWcdbTestAdapter);

describe("WCDB differential repository semantics", () => {
	integrationIt("matches JSONL for headers, graph, tools, context, compaction, labels, custom data, attachments, and provenance", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-differential-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const fixture = path.join(fixtureDir, "omp-v3-complete.jsonl");
		await driver.invoke("reset", { mode: "db" });
		await driver.invoke("importArchive", {
			source: fixture,
			sourceNamespace: "omp-v3",
			replicaId: "replica-db",
		});
		const jsonl = await driver.invoke<RepositoryObservation>("observeRepository", {
			mode: "jsonl",
			source: fixture,
			selectedLeaf: "u2",
		});
		const db = await driver.invoke<RepositoryObservation>("observeRepository", {
			mode: "db",
			selectedLeaf: "u2",
		});

		expect(db.header).toEqual(jsonl.header);
		expect(db.graph).toEqual(jsonl.graph);
		expect(db.selectedLeaf).toBe(jsonl.selectedLeaf);
		expect(db.toolPairs).toEqual(jsonl.toolPairs);
		expect(db.contextMessages).toEqual(jsonl.contextMessages);
		expect(db.contextHash).toBe(jsonl.contextHash);
		expect(db.compaction).toEqual(jsonl.compaction);
		expect(db.labels).toEqual(jsonl.labels);
		expect(db.custom).toEqual(jsonl.custom);
		expect(db.attachments).toEqual(jsonl.attachments);
		expect(db.provenance).toEqual(jsonl.provenance);
		expect(db.versionIds).toEqual(jsonl.versionIds);
		expect(db.branchIds).toEqual(jsonl.branchIds);
		expect(db.aliases).toEqual(jsonl.aliases);
		expect(db.metadataRevisionIds).toEqual(jsonl.metadataRevisionIds);
		expect(db.payloadHashes).toEqual(jsonl.payloadHashes);
	});

	integrationIt("keeps the mutable title slot separate from append-only title history", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-title-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const body = await Bun.file(path.join(fixtureDir, "omp-v3-complete.jsonl")).text();
		const titledFixture = path.join(workspace.path(), "title-slot.jsonl");
		await Bun.write(
			titledFixture,
			`${serializeTitleSlot({ title: "Slot wins", source: "user", updatedAt: "2026-03-01T00:00:00.000Z" })}${body}`,
		);
		await driver.invoke("reset", { mode: "db" });
		await driver.invoke("importArchive", {
			source: titledFixture,
			sourceNamespace: "omp-v3-title",
			replicaId: "replica-title",
		});
		const jsonl = await driver.invoke<RepositoryObservation>("observeRepository", {
			mode: "jsonl",
			source: titledFixture,
			selectedLeaf: "u2",
		});
		const db = await driver.invoke<RepositoryObservation>("observeRepository", {
			mode: "db",
			selectedLeaf: "u2",
		});
		expect(db.currentTitle).toEqual(jsonl.currentTitle);
		expect(db.currentTitle).toEqual({ title: "Slot wins", source: "user" });
		expect(db.titleHistory).toEqual(jsonl.titleHistory);
		expect(db.titleHistory).toEqual([
			{ title: "User title", previousTitle: "Header title", source: "user", trigger: "fixture" },
		]);
	});

	integrationIt("exercises paginated list/search/tree, lookup, checkpoint/tail, payload streaming, flush, and health", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-contract-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await driver.invoke("reset", { mode: "db" });
		await driver.invoke("importArchive", {
			source: path.join(fixtureDir, "omp-v3-complete.jsonl"),
			sourceNamespace: "omp-v3",
			replicaId: "replica-contract",
		});
		const probe = await driver.invoke<RepositoryContractProbe>("exerciseRepositoryContract", {
			pageSize: 1,
			search: { query: "mañana src", phrase: "Running lookup", prefix: "look" },
			branchLeaf: "u2",
			payloadId: "binary-attachment",
		});
		expect(probe.capabilities).toEqual({
			list: true,
			search: true,
			tree: true,
			checkpoint: true,
			payloadStreaming: true,
		});
		expect(new Set([...probe.firstPageIds, ...probe.secondPageIds]).size).toBe(
			probe.firstPageIds.length + probe.secondPageIds.length,
		);
		expect(probe.searchEventIds).toContain("u1");
		expect(probe.treeEventIds).toEqual(["u1", "a1", "t1", "p1", "x1", "title1", "label1", "c1", "cm1", "u2"]);
		expect(probe.headerOriginId).toBe("origin:omp:complete");
		expect(probe.tailEventIds.at(-1)).toBe("u2");
		expect(probe.checkpointHeadHash.length).toBe(64);
		const streamed = Buffer.concat(probe.payloadChunksBase64.map(chunk => Buffer.from(chunk, "base64")));
		expect(streamed).toEqual(Buffer.from([0, 1, 2, 0, 255]));
		expect(probe.flushDurable).toBe(true);
		expect(probe.health).toEqual({ mode: "db", ready: true });
	});
});
