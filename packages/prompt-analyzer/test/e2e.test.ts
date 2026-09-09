/**
 * End-to-end through the real configured OMP model path: the real CLI entry,
 * the real SDK transport, real model calls, one real browser protocol session.
 *
 * Nothing is stubbed. The prerequisite is this fork's credential store
 * (`~/.buddha/agent/agent.db`, table `auth_credentials`) — the SDK resolves
 * OAuth from there, no API-key env var is involved. Inside a jail that means
 * the config dir must be mounted read-write with `HOME` pointing at it; when
 * it is absent the case reports a skip rather than a false failure.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { activeQuestionIds, EXCLUDED_QUESTION_PREFIX, isCategory, SUBCATEGORIES } from "../src/registry";
import { connectClient } from "./fixtures/ws-client";

/** Every subcategory name in the registry, for validating a live result's labels. */
const SUBCATEGORY_NAMES = new Set(Object.values(SUBCATEGORIES).flat());

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const CREDENTIAL_STORE = path.join(process.env.HOME ?? "", ".buddha", "agent", "agent.db");
const LIVE_PROMPT =
	"Please add rate limiting to the login endpoint, but do not use Redis. Thanks for the quick fix yesterday!";

const hasCredential = fs.existsSync(CREDENTIAL_STORE) || Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!hasCredential)("live model end-to-end", () => {
	it("case 19: a real run through the configured model produces a verified analysis", async () => {
		const child = Bun.spawn({
			cmd: ["bun", "run", "packages/prompt-analyzer/src/main.ts", "--port", "0"],
			cwd: REPO_ROOT,
			env: { ...process.env, ANALYZER_MODEL: process.env.ANALYZER_MODEL ?? "anthropic/claude-sonnet-5:low" },
			stdout: "pipe",
			stderr: "pipe",
		});

		try {
			const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let banner = "";
			while (!/http:\/\/localhost:(\d+)/.test(banner)) {
				const { value, done } = await reader.read();
				if (done) throw new Error(`analyzer exited before serving; stderr: ${banner}`);
				banner += decoder.decode(value, { stream: true });
			}
			reader.releaseLock();
			const port = Number(/http:\/\/localhost:(\d+)/.exec(banner)?.[1]);

			const browser = await connectClient(port);
			browser.send({ type: "analyze", rawPrompt: LIVE_PROMPT });

			const started = await browser.waitFor(event => event.type === "run_started", 60_000);
			if (started.type !== "run_started") throw new Error("expected run_started");
			const verified = await browser.waitFor(event => event.type === "run_verified", 240_000);
			if (verified.type !== "run_verified") throw new Error("expected run_verified");
			await browser.close();

			const analysis = verified.result;
			expect(analysis.rawPrompt).toBe(LIVE_PROMPT);
			expect(analysis.promptHash).toBe(started.promptHash);
			expect(analysis.paraphrase.length).toBeGreaterThan(0);
			expect(analysis.parts.length).toBeGreaterThan(0);
			// Every part quotes the prompt verbatim and carries registry-valid labels.
			const detected = new Set<string>();
			for (const part of analysis.parts) {
				expect(LIVE_PROMPT).toContain(part.source);
				expect(part.categories.length).toBeGreaterThan(0);
				for (const category of part.categories) {
					expect(isCategory(category)).toBe(true);
					detected.add(category);
				}
				for (const subcategory of part.subcategories) {
					expect(SUBCATEGORY_NAMES.has(subcategory)).toBe(true);
				}
			}
			// The run may answer a subset of the activated questions, but never a
			// question the detected categories never activated, and never a CTX-*.
			const activated = new Set(activeQuestionIds([...detected]));
			expect(activated.has("INT-01")).toBe(true);
			expect(activated.has("INT-10")).toBe(true);
			expect(analysis.intent.length).toBeGreaterThan(0);
			for (const answer of analysis.intent) {
				expect(activated.has(answer.id)).toBe(true);
				expect(answer.id.startsWith(EXCLUDED_QUESTION_PREFIX)).toBe(false);
				expect(answer.answer.length).toBeGreaterThan(0);
			}
			// The always-on questions are either answered or explicitly flagged; a
			// real run may never silently drop them.
			const answered = analysis.intent.map(answer => answer.id);
			const flagged = analysis.comparison.problems.some(problem => problem.type === "missing_required_intent");
			expect((answered.includes("INT-01") && answered.includes("INT-10")) || flagged).toBe(true);
			expect(analysis.comparison.meaningCoverage).toBeGreaterThanOrEqual(0);
			expect(analysis.comparison.meaningCoverage).toBeLessThanOrEqual(1);
			// The model streamed: deltas reached the client before the result.
			expect(browser.events.some(event => event.type === "stage_delta")).toBe(true);
			const completedStages = browser.events
				.filter(event => event.type === "stage_completed")
				.map(event => (event.type === "stage_completed" ? event.stage : ""));
			expect(completedStages.slice(-2)).toEqual(["analyze", "verify"]);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	}, 300_000);
});
