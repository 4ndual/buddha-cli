import { describe, expect, it } from "bun:test";
import {
	assertSameCanonicalIdentity,
	branchId,
	canonicalIdentityRecord,
	canonicalSha256,
	compareImmutablePrefixes,
	eventIdentityRecord,
	exactDecimal,
	metadataRevisionId,
	originId,
	parseOriginId,
	planCasAppend,
	reconcileAction,
	replicaId,
	semanticProjection,
	sourceAlias,
	versionId,
	type ReconciliationObservation,
	type ReconciliationAction,
} from "../src/storage/identity";

const source = { harness: "omp", installNamespace: "profile-main", nativeSessionId: "native-42" };

describe("canonical semantic identity", () => {
	it("normalizes object-key order while preserving array order", () => {
		expect(canonicalSha256({ a: 1, b: ["x", "y"] })).toBe(canonicalSha256({ b: ["x", "y"], a: 1 }));
		expect(canonicalSha256({ a: 1, b: ["x", "y"] })).not.toBe(canonicalSha256({ a: 1, b: ["y", "x"] }));
	});

	it("keeps absent, undefined, null, sparse arrays, and explicit undefined distinct", () => {
		const hashes = [
			canonicalSha256({}),
			canonicalSha256({ value: undefined }),
			canonicalSha256({ value: null }),
			canonicalSha256(new Array(1)),
			canonicalSha256([undefined]),
		];
		expect(new Set(hashes).size).toBe(hashes.length);
	});

	it("preserves exact decimal precision, IEEE-754 distinctions, and binary view bytes", () => {
		expect(canonicalSha256(exactDecimal("9007199254740993"))).not.toBe(canonicalSha256(9_007_199_254_740_992));
		expect(canonicalSha256(-0)).not.toBe(canonicalSha256(0));
		const backing = Uint8Array.of(99, 1, 2, 3, 88);
		expect(canonicalSha256(backing.subarray(1, 4))).toBe(canonicalSha256(Uint8Array.of(1, 2, 3)));
		expect(canonicalSha256(backing.subarray(1, 4))).not.toBe(canonicalSha256(Uint8Array.of(99, 1, 2)));
	});

	it("excludes transport bookkeeping but includes title semantics", () => {
		expect(canonicalSha256({ title: "A", exportPath: "/one" })).not.toBe(
			canonicalSha256({ title: "A", exportPath: "/two" }),
		);
		const identityA = metadataRevisionId({ title: "A", exportPath: "/one" });
		const identityB = metadataRevisionId({ title: "A", exportPath: "/two" });
		const identityC = metadataRevisionId({ title: "B", exportPath: "/one" });
		expect(identityA).toBe(identityB);
		expect(identityA).not.toBe(identityC);
		const constructorMetadata = metadataRevisionId({ constructor: "meaningful" });
		expect(constructorMetadata).not.toBe(metadataRevisionId({}));
		expect(Object.getPrototypeOf(semanticProjection({ constructor: "meaningful" }))).toBeNull();
	});

	it("detects equal-hash records whose canonical bytes do not match", () => {
		expect(() =>
			assertSameCanonicalIdentity(
				{ hash: "sha256:forced", canonicalLength: 1, canonical: Uint8Array.of(1) },
				{ hash: "sha256:forced", canonicalLength: 1, canonical: Uint8Array.of(2) },
			),
		).toThrow("Canonical hash collision");
		expect(() =>
			assertSameCanonicalIdentity(
				{ hash: "sha256:forced", canonicalLength: 1, canonical: Uint8Array.of(1) },
				{ hash: "sha256:forced", canonicalLength: 1, canonical: Uint8Array.of(1, 2) },
			),
		).toThrow("Canonical hash collision");
	});
});

describe("origin, event, version, and branch identity", () => {
	it("namespaces duplicate native IDs by harness installation and validates opaque IDs", () => {
		const primary = originId(source);
		const copiedInstall = originId({ ...source, installNamespace: "profile-copy" });
		const foreignHarness = originId({ ...source, harness: "codex" });
		expect(primary).not.toBe(copiedInstall);
		expect(primary).not.toBe(foreignHarness);
		expect(parseOriginId(primary)).toBe(primary);
		expect(() => parseOriginId("native-42")).toThrow("Invalid origin identity");
		expect(sourceAlias(source)).not.toBe(primary);
	});

	it("forks the same native event ID when its semantic payload changes", () => {
		const origin = originId(source);
		const common = {
			originId: origin,
			nativeEntryId: "entry-7",
			parentHash: null,
			kind: "message",
			timestamp: "2026-09-15T00:00:00.000Z",
		};
		const first = eventIdentityRecord({ ...common, semanticPayload: { role: "user", content: "first" } });
		const edited = eventIdentityRecord({ ...common, semanticPayload: { role: "user", content: "edited" } });
		expect(first.eventHash).not.toBe(edited.eventHash);
	});

	it("keeps equal-content explicit branches distinct while versions share semantic identity", () => {
		const origin = originId(source);
		const replica = replicaId("profile-main", "install-nonce");
		const metadata = metadataRevisionId({ title: "same" });
		const semanticVersion = versionId({ originId: origin, headHash: null, metadataRevisionId: metadata });
		const left = branchId({ originId: origin, replicaId: replica, branchKey: "left" });
		const right = branchId({ originId: origin, replicaId: replica, branchKey: "right" });
		expect(left).not.toBe(right);
		expect(versionId({ originId: origin, headHash: null, metadataRevisionId: metadata })).toBe(semanticVersion);
	});
});

describe("no-merge lineage", () => {
	const base: ReconciliationObservation = {
		sameOrigin: true,
		sameVersion: false,
		currentIsVerifiedAncestor: false,
		incomingIsVerifiedAncestor: false,
		bothExtendSameBaseDifferently: false,
		sameNativeEventIdDifferentPayload: false,
		historicalEditOrTruncation: false,
		metadataOnlyDivergence: false,
		identityResolved: true,
		oneSideAbsent: false,
	};
	const matrix: Array<[Partial<ReconciliationObservation>, ReconciliationAction]> = [
		[{ sameVersion: true }, "no-op"],
		[{ currentIsVerifiedAncestor: true }, "import-suffix-cas"],
		[{ bothExtendSameBaseDifferently: true }, "preserve-sibling-branches"],
		[{ sameNativeEventIdDifferentPayload: true }, "fork-conflicting-event"],
		[{ historicalEditOrTruncation: true }, "fork-historical-edit"],
		[{ metadataOnlyDivergence: true }, "preserve-metadata-revisions"],
		[{ identityResolved: false }, "retain-unresolved"],
		[{ oneSideAbsent: true }, "ignore-absence"],
	];

	it("executes every reconciliation matrix row without merge or deletion", () => {
		for (const [change, expected] of matrix) expect(reconcileAction({ ...base, ...change })).toBe(expected);
	});

	it("shares A→B immutably and identifies C/D as siblings forked at B", () => {
		const records = ["A", "B", "C", "D"].map(value => canonicalIdentityRecord({ value }));
		const events = records.map((identity, index) => ({ hash: `event-v1:${index}` as never, identity }));
		const comparison = compareImmutablePrefixes([events[0], events[1], events[2]], [events[0], events[1], events[3]]);
		expect(comparison.sharedLength).toBe(2);
		expect(comparison.relationship).toBe("diverged");
		expect(comparison.forkPointHash).toBe(events[1].hash);
	});

	it("keeps a CAS loser's append on a stable sibling at its original expected head", () => {
		const origin = originId(source);
		const replica = replicaId("profile-main", "install-nonce");
		const winner = branchId({ originId: origin, replicaId: replica, branchKey: "main" });
		const observation = {
			originId: origin,
			replicaId: replica,
			branchId: winner,
			expectedHeadHash: "event-v1:B" as never,
			actualHeadHash: "event-v1:C" as never,
			incomingEventHash: "event-v1:D" as never,
			operationId: "append-D",
		};
		const first = planCasAppend(observation);
		const repeated = planCasAppend(observation);
		expect(first).toEqual(repeated);
		expect(first).toMatchObject({
			outcome: "sibling-fork",
			winnerBranchId: winner,
			forkPointHash: "event-v1:B",
			parentHash: "event-v1:B",
		});
	});
});
