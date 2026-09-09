/**
 * Server-level contract: process lifecycle, reconnect replay, stale-run
 * suppression, and stdout hygiene.
 *
 * The model boundary is stubbed (`createFixtureTransport` drives the real
 * pipeline), except in the process-lifecycle case, which runs the real CLI
 * entry with the real SDK transport — it never issues an analyze request, so
 * no model call and no credential is involved.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { RunningServer } from "../src/server";
import { startServer } from "../src/server";
import type { StageSpec } from "./fixtures/fake-stage-call";
import { createFixtureTransport } from "./fixtures/fake-transport";
import { PART_A, PART_B, SIMPLE_PROMPT } from "./fixtures/prompts";
import { analyzeResponse, categorizeResponse, paraphraseResponse, verifyResponse } from "./fixtures/stage-responses";
import { connectClient, type EventClient } from "./fixtures/ws-client";
import type { Stage } from "../src/contracts";

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

function singlePartSpecs(prompt: string, delayMs = 0): Partial<Record<Stage, StageSpec>> {
	return {
		paraphrase: {
			json: paraphraseResponse([{ source: prompt, paraphrase: "A clearer restatement." }]),
			delayMs,
		},
		categorize: { json: categorizeResponse([{ text: prompt, categories: ["DIRECT"] }]), delayMs },
		analyze: {
			json: analyzeResponse(
				[{ text: prompt, subcategories: ["build_request"], tags: ["auth"] }],
				[{ id: "INT-01", answer: "Requested work.", source: prompt }],
			),
		},
		verify: { json: verifyResponse({}) },
	};
}


const openServers: RunningServer[] = [];
const openClients: EventClient[] = [];

afterEach(async () => {
	await Promise.all(openClients.splice(0).map(client => client.close()));
	await Promise.all(openServers.splice(0).map(server => server.close()));
});

async function boot(specs: Partial<Record<Stage, StageSpec>>): Promise<RunningServer> {
	const transport = createFixtureTransport(specs);
	await transport.start();
	const server = await startServer({ port: 0, transport, verbose: false });
	openServers.push(server);
	return server;
}

async function client(port: number): Promise<EventClient> {
	const connected = await connectClient(port);
	openClients.push(connected);
	return connected;
}

/** Read a stream until `pattern` matches the text seen so far, or time out. */
async function readUntil(stream: ReadableStream<Uint8Array>, pattern: RegExp, timeoutMs: number): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			if (pattern.test(text)) return text;
		}
	} finally {
		reader.releaseLock();
	}
	throw new Error(`stream never matched ${pattern}; saw: ${JSON.stringify(text)}`);
}

describe("analyzer server", () => {
	it("case 1: the CLI starts, serves, shuts down cleanly on SIGTERM and leaves no child processes", async () => {
		const child = Bun.spawn({
			cmd: ["bun", "run", "packages/prompt-analyzer/src/main.ts", "--port", "0"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});

		// The startup banner (stderr, never stdout) carries the bound port.
		const banner = await readUntil(child.stderr as ReadableStream<Uint8Array>, /http:\/\/localhost:(\d+)/, 30_000);
		const port = Number(/http:\/\/localhost:(\d+)/.exec(banner)?.[1]);
		expect(Number.isInteger(port)).toBe(true);

		// It really is serving: the UI is reachable on the announced port.
		const page = await fetch(`http://127.0.0.1:${port}/`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Buddha Prompt Analyzer");

		child.kill("SIGTERM");
		const exitCode = await child.exited;
		expect(exitCode).toBe(0);

		// No orphaned descendants of the CLI process.
		const survivors = Bun.spawnSync({ cmd: ["ps", "--no-headers", "-o", "pid", "--ppid", String(child.pid)] });
		expect(new TextDecoder().decode(survivors.stdout).trim()).toBe("");

		// The listener is gone: the port binds again immediately.
		const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
		expect(rebound.port).toBe(port);
		rebound.stop(true);
	}, 60_000);

	it("case 2: a browser that reconnects mid-run is pushed the current run state and the remaining live events", async () => {
		const server = await boot(singlePartSpecs(SIMPLE_PROMPT, 250));
		const first = await client(server.port);

		first.send({ type: "analyze", rawPrompt: SIMPLE_PROMPT });
		const started = await first.waitFor(event => event.type === "run_started");
		if (started.type !== "run_started") throw new Error("expected run_started");
		await first.waitFor(event => event.type === "stage_started" && event.stage === "paraphrase");

		// Drop the socket while wave 1 is still generating.
		await first.close();

		const second = await client(server.port);
		// The reconnecting client sends nothing at all.
		const replayedStart = await second.waitFor(event => event.type === "run_started");
		if (replayedStart.type !== "run_started") throw new Error("expected replayed run_started");
		expect(replayedStart.runId).toBe(started.runId);
		expect(replayedStart.promptHash).toBe(started.promptHash);

		const verified = await second.waitFor(event => event.type === "run_verified", 10_000);
		if (verified.type !== "run_verified") throw new Error("expected run_verified");
		expect(verified.runId).toBe(started.runId);
		expect(verified.result.rawPrompt).toBe(SIMPLE_PROMPT);
		expect(verified.result.parts).toHaveLength(1);
		// Exactly one run: the reconnect replayed state, it did not start a second run.
		expect(second.events.filter(event => event.type === "run_started")).toHaveLength(1);
		expect(second.events.some(event => event.type === "stage_completed" && event.stage === "verify")).toBe(true);
	}, 30_000);

	it("case 6: a superseded prompt hash never delivers another result frame to the client", async () => {
		// Both prompts contain SIMPLE_PROMPT verbatim, so one fixture's source
		// spans stay valid for whichever run the server is driving.
		const supersededPrompt = `${SIMPLE_PROMPT} ${PART_B}`;
		const winningPrompt = `${SIMPLE_PROMPT} ${PART_A}`;
		const server = await boot(singlePartSpecs(SIMPLE_PROMPT, 400));
		const browser = await client(server.port);

		browser.send({ type: "analyze", rawPrompt: supersededPrompt });
		const stale = await browser.waitFor(event => event.type === "run_started");
		if (stale.type !== "run_started") throw new Error("expected run_started");
		await browser.waitFor(event => event.type === "stage_started");

		// A different prompt supersedes the in-flight run.
		browser.send({ type: "analyze", rawPrompt: winningPrompt });
		const staleFrame = await browser.waitFor(event => event.type === "run_stale");
		if (staleFrame.type !== "run_stale") throw new Error("expected run_stale");
		expect(staleFrame.runId).toBe(stale.runId);

		const fresh = await browser.waitFor(
			event => event.type === "run_started" && event.runId !== stale.runId,
			10_000,
		);
		if (fresh.type !== "run_started") throw new Error("expected a second run_started");
		expect(fresh.promptHash).not.toBe(stale.promptHash);
		const verified = await browser.waitFor(event => event.type === "run_verified", 10_000);
		if (verified.type !== "run_verified") throw new Error("expected run_verified");
		expect(verified.runId).toBe(fresh.runId);
		expect(verified.result.rawPrompt).toBe(winningPrompt);

		// Nothing from the superseded run reached the client after it went stale.
		const staleIndex = browser.events.indexOf(staleFrame);
		const lateStaleFrames = browser.events
			.slice(staleIndex + 1)
			.filter(event => "runId" in event && event.runId === stale.runId);
		expect(lateStaleFrames).toEqual([]);
		expect(browser.events.some(event => event.type === "run_verified" && event.runId === stale.runId)).toBe(false);
	}, 30_000);

	it("case 18: a full verbose run writes nothing to stdout and its log lines go to stderr", async () => {
		const harness = Bun.spawn({
			cmd: ["bun", "run", "test/fixtures/stdout-purity-harness.ts"],
			cwd: PACKAGE_DIR,
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(harness.stdout as ReadableStream<Uint8Array>).text(),
			new Response(harness.stderr as ReadableStream<Uint8Array>).text(),
			harness.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stdout).toBe("");
		// The run really happened, and its human log landed on stderr.
		expect(stderr).toContain("Prompt accepted");
		expect(stderr).toContain("Analysis verified");
	}, 60_000);
});
