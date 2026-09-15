import { describe, expect, it } from "bun:test";
import {
	createTursoSessionRepository,
	type TursoRuntimeAdapter,
	type TursoRuntimeTransaction,
} from "../../../src/session/repository/turso/repository";
import type {
	BranchId,
	CheckpointId,
	EventHash,
	ModeGeneration,
	PayloadHash,
} from "../../../src/session/repository/types";

const expectedModeGeneration = "mode-generation:4" as ModeGeneration;

describe("Turso indexing and checkpoint cancellation", () => {
	it("propagates checkpoint cancellation without publishing a completed checkpoint", async () => {
		let completedCheckpoints = 0;
		const adapter = {
			replicaId: "replica:fixture",
			async transaction<T>(work: (transaction: TursoRuntimeTransaction) => Promise<T>) {
				return work({
					async assertModeGeneration() {},
					async putCheckpoint() {
						throw new Error("injected checkpoint cancellation");
					},
				} as unknown as TursoRuntimeTransaction);
			},
		} as unknown as TursoRuntimeAdapter;
		const repository = createTursoSessionRepository({ adapter });

		await expect(
			repository
				.putCheckpoint({
					expectedModeGeneration,
					checkpoint: {
						checkpointId: "checkpoint:fixture" as CheckpointId,
						branchId: "branch-main" as BranchId,
						headEventHash: "event-head" as EventHash,
						contextBuilderVersion: "context-v1",
						contextHash: "context-hash",
						payloadHash: "payload-checkpoint" as PayloadHash,
						createdAt: "2026-09-15T12:00:00.000Z",
					},
				})
				.then(() => {
					completedCheckpoints += 1;
				}),
		).rejects.toThrow("injected checkpoint cancellation");
		expect(completedCheckpoints).toBe(0);
	});

	it("propagates cancellation from an in-flight search adapter and publishes no page", async () => {
		let searches = 0;
		const adapter = {
			replicaId: "replica:fixture",
			async search() {
				searches += 1;
				throw new Error("injected index search cancellation");
			},
		} as unknown as TursoRuntimeAdapter;
		const repository = createTursoSessionRepository({ adapter });

		await expect(repository.search({ text: "needle" })).rejects.toThrow("injected index search cancellation");
		expect(searches).toBe(1);
	});
});
