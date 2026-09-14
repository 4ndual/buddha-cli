import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const session = {} as AgentSession;

describe("AgentRegistry assignment invariant", () => {
	it("requires explicit work for running subagents but exempts Main", () => {
		const registry = new AgentRegistry();
		const worker = registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			session,
			status: "running",
		});
		expect(worker.status).toBe("idle");
		expect(worker.assignment).toBeUndefined();
		expect(() =>
			registry.register({ id: "Main", displayName: "Main", kind: "main", session, status: "running" }),
		).not.toThrow();
	});

	it("clears completed work and requires a fresh assignment before reactivation", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			session,
			status: "running",
			assignment: "first job",
		});
		expect(registry.completeAssignment(ref.id, 1, "idle", ref)).toBe(true);
		expect(ref.assignment).toBeUndefined();
		expect(registry.setStatus(ref.id, "running", ref)).toBe(false);
		expect(() => registry.beginAssignment(ref.id, "  ", ref)).toThrow("requires a nonempty new assignment");
		const generation = registry.beginAssignment(ref.id, "second job", ref);
		expect(generation).toBe(2);
		expect(registry.setStatus(ref.id, "running", ref)).toBe(true);
		expect(ref.assignment).toBe("second job");
	});

	it("does not let late completion clear a successor generation", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			session,
			status: "running",
			assignment: "first job",
		});
		const successor = registry.beginAssignment(ref.id, "successor job", ref);
		expect(registry.completeAssignment(ref.id, 1, "idle", ref)).toBe(false);
		expect(ref.status).toBe("running");
		expect(ref.assignment).toBe("successor job");
		expect(ref.assignmentGeneration).toBe(successor);
	});
});
