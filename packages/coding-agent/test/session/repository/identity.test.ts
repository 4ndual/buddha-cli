import { describe, expect, test } from "bun:test";
import {
	canonicalEqual,
	canonicalSerialize,
	computeEventIdentity,
	computeOriginIdentity,
	computeVersionIdentity,
	IdentityCollisionError,
	IdentityCollisionRegistry,
} from "../../../src/session/repository";
import type { BranchId, EventHash, SessionSemanticMetadata } from "../../../src/session/repository";

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

describe("canonical session identity", () => {
	test("sorts object keys while retaining array order, absence, precision, and binary bytes", () => {
		expect(canonicalEqual({ z: 1, a: { y: true, x: "value" } }, { a: { x: "value", y: true }, z: 1 })).toBeTrue();
		expect(hex(canonicalSerialize(["a", "b"]))).not.toBe(hex(canonicalSerialize(["b", "a"])));
		expect(hex(canonicalSerialize({ value: undefined }))).not.toBe(hex(canonicalSerialize({ value: null })));
		expect(hex(canonicalSerialize({}))).not.toBe(hex(canonicalSerialize({ value: undefined })));
		expect(hex(canonicalSerialize(9_007_199_254_740_991))).not.toBe(hex(canonicalSerialize(9_007_199_254_740_990)));
		expect(hex(canonicalSerialize(9_007_199_254_740_993n))).not.toBe(
			hex(canonicalSerialize(9_007_199_254_740_992n)),
		);
		expect(canonicalEqual(new Uint8Array([0, 255, 17]), new Uint8Array([0, 255, 17]))).toBeTrue();
		expect(canonicalEqual(new Uint8Array([0, 255, 17]), new Uint8Array([0, 254, 17]))).toBeFalse();
	});

	test("namespaces duplicate native ids and includes title metadata in version identity", () => {
		const omp = computeOriginIdentity({ sourceNamespace: "omp", installationNamespace: "profile-a", nativeId: "same" });
		const codex = computeOriginIdentity({
			sourceNamespace: "codex",
			installationNamespace: "profile-a",
			nativeId: "same",
		});
		expect(omp.id).not.toBe(codex.id);

		const event = computeEventIdentity({
			originId: omp.id,
			nativeEntryId: "entry-a",
			parentEventHash: null,
			semanticPayload: { type: "custom", data: { exact: 1 } },
		});
		const baseMetadata: SessionSemanticMetadata = { createdAt: "2026-09-15T00:00:00.000Z", title: "Before" };
		const before = computeVersionIdentity({
			originId: omp.id,
			branchId: "branch_v1_metadata" as BranchId,
			headEventHash: event.id,
			metadata: baseMetadata,
		});
		const after = computeVersionIdentity({
			originId: omp.id,
			branchId: "branch_v1_metadata" as BranchId,
			headEventHash: event.id,
			metadata: { ...baseMetadata, title: "After" },
		});
		expect(before.id).not.toBe(after.id);
	});

	test("fails closed when one identity is associated with different canonical bytes", () => {
		const origin = computeOriginIdentity({ sourceNamespace: "omp", installationNamespace: "profile", nativeId: "s" });
		const registry = new IdentityCollisionRegistry();
		registry.remember(origin);
		expect(() =>
			registry.remember({
				...origin,
				canonicalLength: origin.canonicalLength + 1,
				canonicalBytes: new Uint8Array([...origin.canonicalBytes, 0]),
			}),
		).toThrow(IdentityCollisionError);
	});

	test("uses the chained head hash as the ordered ancestry commitment", () => {
		const origin = computeOriginIdentity({ sourceNamespace: "omp", installationNamespace: "profile", nativeId: "tree" });
		const metadata = { createdAt: "2026-09-15T00:00:00.000Z" };
		const first = computeVersionIdentity({
			originId: origin.id,
			branchId: "branch_v1_tree" as BranchId,
			headEventHash: "event_v1_a" as EventHash,
			metadata,
		});
		const second = computeVersionIdentity({
			originId: origin.id,
			branchId: "branch_v1_tree" as BranchId,
			headEventHash: "event_v1_b" as EventHash,
			metadata,
		});
		expect(first.id).not.toBe(second.id);
		expect(first.id).toStartWith("version_v2_");
	});
});
