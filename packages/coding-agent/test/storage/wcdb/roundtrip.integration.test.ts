import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { hasWcdbTestAdapter, type JsonValue, WcdbMigrationTestDriver } from "./migration-test-driver";

interface SemanticSnapshot extends Record<string, JsonValue> {
	originIds: string[];
	aliases: JsonValue;
	branches: JsonValue;
	versions: string[];
	metadataRevisions: JsonValue;
	events: JsonValue;
	payloadHashes: string[];
	attachments: JsonValue;
	custom: JsonValue;
	provenance: JsonValue;
}

interface ExportResult extends Record<string, JsonValue> {
	bundlePath: string;
	manifestHash: string;
	completionMarker: string;
	cutoffVersions: string[];
}

interface CanonicalHashProbe extends Record<string, JsonValue> {
	hashes: {
		absent: string;
		null: string;
		orderedA: string;
		orderedB: string;
		decimal: string;
		binary: string;
	};
	roundTrip: {
		decimal: string;
		binaryBase64: string;
	};
}

const fixtureDir = path.resolve(import.meta.dir, "../../fixtures/wcdb");
const integrationIt = it.skipIf(!hasWcdbTestAdapter);

async function semanticSnapshot(driver: WcdbMigrationTestDriver): Promise<SemanticSnapshot> {
	return driver.invoke<SemanticSnapshot>("semanticSnapshot");
}

describe("WCDB logical archive round trips", () => {
	integrationIt("preserves semantic versions, forks, aliases, metadata, and payload hashes through JSONL bundle to DB to JSONL to DB", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-roundtrip-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		await driver.invoke("reset", { database: "first" });
		await driver.invoke("importArchive", {
			source: path.join(fixtureDir, "omp-v3-complete.jsonl"),
			sourceNamespace: "omp-v3",
			replicaId: "roundtrip-jsonl",
		});
		const first = await semanticSnapshot(driver);
		const exported = await driver.invoke<ExportResult>("exportArchive", {
			destination: path.join(workspace.path(), "export-generation"),
			allBranches: true,
		});
		expect(exported.manifestHash.length).toBe(64);
		expect(await Bun.file(exported.completionMarker).exists()).toBe(true);
		expect(exported.cutoffVersions.sort()).toEqual([...first.versions].sort());

		await driver.invoke("reset", { database: "second" });
		await driver.invoke("importArchive", {
			source: exported.bundlePath,
			sourceNamespace: "omp-export",
			replicaId: "roundtrip-db",
		});
		const second = await semanticSnapshot(driver);
		expect(second).toEqual(first);
	});

	for (const fixture of ["omp-v1-legacy.jsonl", "omp-v2-legacy.jsonl"] as const) {
		integrationIt(`migrates and round-trips ${fixture} as current OMP semantics`, async () => {
			using workspace = TempDir.createSync("@omp-wcdb-old-version-");
			const driver = new WcdbMigrationTestDriver(workspace.path());
			await driver.invoke("reset", { database: "legacy-first" });
			const imported = await driver.invoke<{ normalizedVersion: number; disposition: string } & Record<string, JsonValue>>(
				"importArchive",
				{
					source: path.join(fixtureDir, fixture),
					sourceNamespace: fixture.startsWith("omp-v1") ? "omp-v1" : "omp-v2",
					replicaId: "legacy-source",
				},
			);
			expect(imported.normalizedVersion).toBe(3);
			expect(imported.disposition).toBe("resumable");
			const first = await semanticSnapshot(driver);
			const exported = await driver.invoke<ExportResult>("exportArchive", {
				destination: path.join(workspace.path(), `${fixture}.bundle`),
				allBranches: true,
			});
			await driver.invoke("reset", { database: "legacy-second" });
			await driver.invoke("importArchive", {
				source: exported.bundlePath,
				sourceNamespace: "legacy-export",
				replicaId: "legacy-destination",
			});
			expect(await semanticSnapshot(driver)).toEqual(first);
		});
	}

	integrationIt("distinguishes absent from null while preserving object-order invariance, decimal precision, and binary bytes", async () => {
		using workspace = TempDir.createSync("@omp-wcdb-canonical-");
		const driver = new WcdbMigrationTestDriver(workspace.path());
		const probe = await driver.invoke<CanonicalHashProbe>("canonicalHashProbe", {
			absent: {},
			null: { value: null },
			orderedA: { alpha: 1, beta: 2 },
			orderedB: { beta: 2, alpha: 1 },
			decimal: { canonicalDecimal: "9007199254740993.125" },
			binary: { encoding: "base64", data: "AAECAP8=" },
		});
		expect(probe.hashes.absent).not.toBe(probe.hashes.null);
		expect(probe.hashes.orderedA).toBe(probe.hashes.orderedB);
		expect(probe.roundTrip.decimal).toBe("9007199254740993.125");
		expect(probe.roundTrip.binaryBase64).toBe("AAECAP8=");
		expect(probe.hashes.decimal.length).toBe(64);
		expect(probe.hashes.binary.length).toBe(64);
	});
});
