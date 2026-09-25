import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RawCallTrace, pruneRawTraces, rawTraceRoot } from "../src/session/raw-call-trace";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("raw model-call trace", () => {
	it("records the full request and every stream event without truncating and writes off the call path", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-wire-trace-"));
		roots.push(root);
		const trace = new RawCallTrace(path.join(root, "agent", "sessions", "work", "call.jsonl"));
		const huge = "x".repeat(100_000);
		trace.record("request", { instructions: huge, tools: [{ description: huge }] });
		for (let index = 0; index < 200; index++) trace.record("event", { index, data: huge.slice(0, 1000) });
		const filename = trace.finish({ inputTokens: 200 });
		expect(filename).toStartWith(path.join(root, "agent", "raw-calls"));
		expect((await trace.settled()).failure).toBeNull();
		const rows = (await readFile(filename, "utf8")).trim().split("\n").map(line => JSON.parse(line));
		expect(rows).toHaveLength(203);
		expect(rows[0].value.sessionFile).toContain("call.jsonl");
		expect(rows[1].value.instructions).toHaveLength(100_000);
		expect(rows[201].value.index).toBe(199);
		expect(rows[202].kind).toBe("complete");
	});

	it("keeps traces for at least three days and prunes only owned files older than seven", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-wire-retention-"));
		roots.push(root);
		const now = Date.now();
		const old = `call-${now - 8 * 86400_000}-${randomUUID()}.jsonl`;
		const recent = `call-${now - 4 * 86400_000}-${randomUUID()}.jsonl`;
		const unrelated = "session.jsonl";
		for (const name of [old, recent, unrelated]) await writeFile(path.join(root, name), "test");
		for (const name of [old, recent]) {
			const age = name === old ? 8 : 4;
			const when = new Date(now - age * 86400_000);
			await utimes(path.join(root, name), when, when);
		}
		await pruneRawTraces(root, now);
		expect((await readdir(root)).sort()).toEqual([recent, unrelated].sort());
	});

	it("derives a profile-local trace root from its session file", () => {
		expect(rawTraceRoot("/home/a/profile/agent/sessions/-workspace/call.jsonl"))
			.toBe("/home/a/profile/agent/raw-calls");
	});

	it("reports a storage failure without throwing into the model call", async () => {
		const failures: string[] = [];
		const trace = new RawCallTrace("/proc/omp-trace-denied/sessions/call.jsonl", error => failures.push(error));
		trace.record("request", { instructions: "continue inference" });
		expect(() => trace.finish({ done: true })).not.toThrow();
		expect((await trace.settled()).failure).not.toBeNull();
		expect(failures).toHaveLength(1);
	});
});
