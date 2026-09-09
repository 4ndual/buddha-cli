/**
 * Real headless Chrome harness for the UI cases.
 *
 * The page is served by the real server (static assets plus `/ws`), with the
 * model boundary stubbed, then driven through actual keyboard and mouse input.
 *
 * Note on worlds: this repo's patched puppeteer-core evaluates `page.evaluate`
 * in an **isolated** world, which shares the DOM but not the page's globals —
 * verified in-pod: `window.__analyzer` reads as `object` over raw CDP and
 * `undefined` through `page.evaluate`. DOM assertions therefore use
 * `page.evaluate`, while the page's own test seam is reached over CDP
 * `Runtime.evaluate`, which runs in the main world.
 */
import * as fs from "node:fs";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import type { AnalysisEvent } from "../../src/contracts";
import type { RunningServer } from "../../src/server";
import { startServer } from "../../src/server";
import { createFixtureTransport } from "./fake-transport";
import { SIMPLE_PROMPT } from "./prompts";
import { analyzeResponse, categorizeResponse, paraphraseResponse, verifyResponse } from "./stage-responses";

const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

export function chromeExecutable(): string | undefined {
	return CHROME_CANDIDATES.find(candidate => candidate !== undefined && fs.existsSync(candidate));
}

export interface UiHarness {
	page: Page;
	browser: Browser;
	server: RunningServer;
	/** Evaluate an expression in the page's own (main) world. */
	mainWorld(expression: string): Promise<unknown>;
	/** Feed events straight into the page's event handler, no socket involved. */
	apply(events: AnalysisEvent[]): Promise<void>;
	close(): Promise<void>;
}

async function mainWorldEval(cdp: CDPSession, expression: string): Promise<unknown> {
	const evaluated = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (evaluated.exceptionDetails) {
		throw new Error(`main-world evaluate failed: ${evaluated.exceptionDetails.text}`);
	}
	return evaluated.result.value;
}

export async function openUi(): Promise<UiHarness> {
	const executablePath = chromeExecutable();
	if (!executablePath) throw new Error("no Chrome executable found for UI tests");

	const transport = createFixtureTransport({
		paraphrase: { json: paraphraseResponse([{ source: SIMPLE_PROMPT, paraphrase: "Build a login page." }]) },
		categorize: { json: categorizeResponse([{ text: SIMPLE_PROMPT, categories: ["DIRECT"] }]) },
		analyze: {
			json: analyzeResponse(
				[{ text: SIMPLE_PROMPT, subcategories: ["build_request"], tags: ["auth"] }],
				[{ id: "INT-01", answer: "Requested a login page.", source: SIMPLE_PROMPT }],
			),
		},
		verify: { json: verifyResponse({}) },
	});
	await transport.start();
	const server = await startServer({ port: 0, transport, verbose: false });

	const browser = await puppeteer.launch({
		executablePath,
		headless: true,
		// --disable-dev-shm-usage: without it the renderer dies with SIGTRAP inside a podman jail.
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
	});
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });

	const cdp = await page.createCDPSession();
	const seamReady = await mainWorldEval(cdp, "typeof window.__analyzer");
	if (seamReady !== "object") throw new Error(`page test seam missing (typeof __analyzer = ${String(seamReady)})`);

	return {
		page,
		browser,
		server,
		mainWorld: expression => mainWorldEval(cdp, expression),
		async apply(events: AnalysisEvent[]): Promise<void> {
			const payload = JSON.stringify(events);
			await mainWorldEval(cdp, `for (const event of ${payload}) window.__analyzer.applyEvent(event);`);
		},
		async close(): Promise<void> {
			await browser.close();
			await server.close();
			await transport.dispose();
		},
	};
}
