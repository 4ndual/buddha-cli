import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildSessionContext } from "../../../src/session/session-context";
import type { FileEntry, SessionEntry, SessionHeader } from "../../../src/session/session-entries";
import { parseSessionContent } from "../../../src/session/session-loader";
import { migrateToCurrentVersion } from "../../../src/session/session-migrations";
import { serializeTitleSlot } from "../../../src/session/session-title-slot";

interface FixtureFile {
	path: string;
	sha256: string;
	disposition: "quarantined" | "resumable";
	reason?: string;
	sourceNamespace?: string;
}

interface InlinePayload {
	id: string;
	encoding: "base64";
	data: string;
	sha256: string;
	length: number;
}

interface FixtureManifest {
	format: string;
	files: FixtureFile[];
	inlinePayloads: InlinePayload[];
}

interface GateCatalog {
	format: string;
	gates: Array<{ id: string; suite: string; observable: string }>;
}

const fixtureDir = path.resolve(import.meta.dir, "../../fixtures/wcdb");

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Buffer.from(digest).toString("hex");
}

async function fixtureText(name: string): Promise<string> {
	return Bun.file(path.join(fixtureDir, name)).text();
}

function sessionEntries(entries: FileEntry[]): SessionEntry[] {
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

const mandatoryGateIds = [
	"accounting.every-source",
	"differential.compaction",
	"differential.context",
	"differential.graph",
	"differential.header",
	"differential.labels-custom-attachments",
	"differential.title-slot-history",
	"differential.tool-pairing",
	"fault.acknowledged-commit",
	"fault.busy-lock",
	"fault.checkpoint-kill",
	"fault.corrupt-db-wal",
	"fault.disk-full",
	"fault.export-kill",
	"fault.indexing-kill",
	"fault.interrupted-upgrade",
	"fault.mode-flip-kill",
	"fault.native-unavailable",
	"fault.normalization-kill",
	"fault.short-write",
	"fault.transaction-kill",
	"filesystem.db-no-jsonl",
	"fork.copied-export",
	"fork.cyclic",
	"fork.duplicate-id-across-harnesses",
	"fork.explicit-deletion",
	"fork.historical-edit",
	"fork.lost-sidecar",
	"fork.malformed",
	"fork.missing-parent",
	"fork.renamed-file",
	"fork.reordered-serialization",
	"fork.repeated-sync-orders",
	"fork.simultaneous-appends",
	"fork.title-only",
	"fork.truncation",
	"identity.absent-null",
	"identity.precision-binary",
	"maintenance.backup",
	"maintenance.fts-rebuild",
	"maintenance.native-crash-reopen",
	"recovery.export-continue-reimport",
	"roundtrip.bundle-db-bundle-db",
	"roundtrip.old-v1",
	"roundtrip.old-v2",
	"startup.db-without-native",
	"startup.jsonl-without-native",
].sort();

describe("WCDB migration fixture corpus", () => {
	it("matches the immutable SHA-256 manifest, including exact binary payload bytes", async () => {
		const manifest = (await Bun.file(path.join(fixtureDir, "manifest.json")).json()) as FixtureManifest;
		expect(manifest.format).toBe("omp-wcdb-verification-fixtures-v1");
		for (const fixture of manifest.files) {
			const bytes = new Uint8Array(await Bun.file(path.join(fixtureDir, fixture.path)).arrayBuffer());
			expect(await sha256(bytes), fixture.path).toBe(fixture.sha256);
		}
		for (const payload of manifest.inlinePayloads) {
			const bytes = Uint8Array.fromBase64(payload.data);
			expect(bytes.byteLength, payload.id).toBe(payload.length);
			expect(await sha256(bytes), payload.id).toBe(payload.sha256);
		}
	});

	it("enumerates every mandatory correctness, fault, maintenance, filesystem, startup, accounting, and recovery gate", async () => {
		const catalog = (await Bun.file(path.join(fixtureDir, "gates.json")).json()) as GateCatalog;
		expect(catalog.format).toBe("omp-wcdb-gates-v1");
		expect(catalog.gates.map(gate => gate.id).sort()).toEqual(mandatoryGateIds);
		for (const gate of catalog.gates) {
			expect(gate.suite.length).toBeGreaterThan(0);
			expect(gate.observable.length).toBeGreaterThan(20);
		}
	});

	it("loads the complete v3 fixture with distinct title slot/history and meaningful context records", async () => {
		const body = await fixtureText("omp-v3-complete.jsonl");
		const slot = serializeTitleSlot({
			title: "Current title from fixed slot",
			source: "user",
			updatedAt: "2026-01-03T00:00:00.000Z",
		});
		const loaded = parseSessionContent(`${slot}${body}`);
		const header = loaded.entries[0] as SessionHeader;
		expect(loaded.invalidHeader).toBe(false);
		expect(loaded.malformedRecords).toBe(0);
		expect(Buffer.byteLength(slot)).toBe(256);
		expect(header.title).toBe("Current title from fixed slot");
		expect(header.titleSource).toBe("user");

		const titleHistory = loaded.entries.filter(entry => entry.type === "title_change");
		expect(titleHistory).toEqual([
			expect.objectContaining({ title: "User title", previousTitle: "Header title", source: "user" }),
		]);
		const custom = loaded.entries.filter(entry => entry.type === "custom");
		expect(custom.map(entry => entry.customType)).toEqual([
			"migration.provenance.v1",
			"fixture.extension.v1",
		]);
		const context = buildSessionContext(sessionEntries(loaded.entries), undefined, undefined, {
			transcript: true,
			keepDanglingToolCalls: true,
		});
		expect(context.messages.some(message => message.role === "toolResult" && message.toolCallId === "call-1")).toBe(
			true,
		);
		expect(context.messages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(JSON.stringify(context.messages)).not.toContain("migration.provenance.v1");
	});

	it("migrates v1 and v2 fixtures through the actual OMP migrations while retaining lineage", async () => {
		const v1 = parseSessionContent(await fixtureText("omp-v1-legacy.jsonl")).entries;
		expect(migrateToCurrentVersion(v1)).toBe(true);
		expect((v1[0] as SessionHeader).version).toBe(3);
		const v1Entries = sessionEntries(v1);
		expect(v1Entries.map(entry => entry.parentId)).toEqual([null, v1Entries[0]?.id, v1Entries[1]?.id]);
		const v1Hook = v1Entries.find(entry => entry.type === "message" && entry.message.role === "custom");
		expect(v1Hook).toBeDefined();
		const v1Compaction = v1Entries.find(entry => entry.type === "compaction");
		expect(v1Compaction?.firstKeptEntryId).toBe(v1Entries[0]?.id);

		const v2 = parseSessionContent(await fixtureText("omp-v2-legacy.jsonl")).entries;
		expect(migrateToCurrentVersion(v2)).toBe(true);
		expect((v2[0] as SessionHeader).version).toBe(3);
		const v2Hook = sessionEntries(v2).find(entry => entry.type === "message" && entry.message.role === "custom");
		expect(v2Hook?.id).toBe("v2-hook");
		expect(v2Hook?.parentId).toBe("v2-u1");
	});

	it("keeps corruption fixtures observably distinct from valid input", async () => {
		const malformed = parseSessionContent(await fixtureText("malformed-and-truncated.jsonl"));
		expect(malformed.malformedRecords).toBe(2);
		expect(malformed.entries.map(entry => entry.type)).toEqual(["session", "message", "message"]);

		const cyclic = parseSessionContent(await fixtureText("cyclic.jsonl"));
		const cyclicParents = sessionEntries(cyclic.entries).map(entry => [entry.id, entry.parentId]);
		expect(cyclicParents).toEqual([
			["cycle-a", "cycle-b"],
			["cycle-b", "cycle-a"],
		]);
		const missingParent = sessionEntries(parseSessionContent(await fixtureText("missing-parent.jsonl")).entries);
		expect(missingParent[0]?.parentId).toBe("never-present");
	});

	it("makes reordered serialization and cross-harness duplicate identities explicit in the inputs", async () => {
		const reorderedA = parseSessionContent(await fixtureText("reordered-tree-a.jsonl")).entries;
		const reorderedB = parseSessionContent(await fixtureText("reordered-tree-b.jsonl")).entries;
		expect(sessionEntries(reorderedA).map(entry => entry.id)).toEqual(["root", "left", "right"]);
		expect(sessionEntries(reorderedB).map(entry => entry.id)).toEqual(["root", "right", "left"]);
		expect(
			sessionEntries(reorderedA)
				.map(entry => JSON.stringify(entry))
				.sort(),
		).toEqual(
			sessionEntries(reorderedB)
				.map(entry => JSON.stringify(entry))
				.sort(),
		);

		const harnessA = parseSessionContent(await fixtureText("duplicate-id-harness-a.jsonl")).entries;
		const harnessB = parseSessionContent(await fixtureText("duplicate-id-harness-b.jsonl")).entries;
		expect((harnessA[0] as SessionHeader).id).toBe((harnessB[0] as SessionHeader).id);
		expect((harnessA[0] as SessionHeader).cwd).not.toBe((harnessB[0] as SessionHeader).cwd);
		expect((sessionEntries(harnessA)[0] as SessionEntry).id).toBe((sessionEntries(harnessB)[0] as SessionEntry).id);
	});
});
