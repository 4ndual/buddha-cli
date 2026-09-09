/**
 * UI behavior in a real headless Chrome: keyboard navigation, `<details>`
 * expand/collapse, and the Raw JSON tools.
 *
 * Every assertion is on what a user can observe — selected tab, visible panel,
 * open/closed disclosure, clipboard content, downloaded file — never on
 * internal app state.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openUi, type UiHarness } from "../fixtures/browser";
import type { TestDomDocument, TestNavigator } from "../fixtures/dom-types";
import { SAMPLE_ANALYSIS, SAMPLE_RUN_EVENTS } from "../fixtures/sample-run";

// Module-scoped, type-only: the browser supplies the real objects at run time.
declare const document: TestDomDocument;
declare const navigator: TestNavigator;

const BOOT_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 60_000;

let ui: UiHarness;

beforeEach(async () => {
	ui = await openUi();
}, BOOT_TIMEOUT_MS);

afterEach(async () => {
	await ui.close();
}, BOOT_TIMEOUT_MS);

/** id of the tab whose `aria-selected` is currently "true". */
function selectedTab(harness: UiHarness): Promise<string | undefined> {
	return harness.page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.id);
}

function visiblePanels(harness: UiHarness): Promise<string[]> {
	return harness.page.evaluate(() =>
		Array.from(document.querySelectorAll('[role="tabpanel"]'))
			.filter(panel => !panel.hasAttribute("hidden"))
			.map(panel => panel.id),
	);
}

function isOpen(harness: UiHarness, selector: string): Promise<boolean | undefined> {
	return harness.page.evaluate(sel => document.querySelector(sel)?.hasAttribute("open"), selector);
}

describe("analyzer UI", () => {
	it("case 14: tabs and cards are operable from the keyboard alone", async () => {
		await ui.apply(SAMPLE_RUN_EVENTS);

		await ui.page.focus("#tab-overview");
		expect(await selectedTab(ui)).toBe("tab-overview");

		await ui.page.keyboard.press("ArrowRight");
		expect(await selectedTab(ui)).toBe("tab-parts");
		expect(await visiblePanels(ui)).toEqual(["panel-parts"]);
		// Roving tabindex follows the selection, so focus moves with it.
		expect(await ui.page.evaluate(() => document.activeElement?.id)).toBe("tab-parts");

		await ui.page.keyboard.press("End");
		expect(await selectedTab(ui)).toBe("tab-raw");
		await ui.page.keyboard.press("Home");
		expect(await selectedTab(ui)).toBe("tab-overview");

		// Card expansion from the keyboard: focus the first part card's summary and toggle it.
		await ui.page.keyboard.press("ArrowRight");
		expect(await selectedTab(ui)).toBe("tab-parts");
		expect(await isOpen(ui, "#parts-list details.part-card")).toBe(false);

		await ui.page.evaluate(() => document.querySelector("#parts-list details.part-card > summary")?.focus());
		expect(await ui.page.evaluate(() => document.activeElement?.tagName)).toBe("SUMMARY");

		await ui.page.keyboard.press("Enter");
		expect(await isOpen(ui, "#parts-list details.part-card")).toBe(true);
		// The card body is genuinely on screen, not just marked open.
		expect(
			await ui.page.evaluate(
				() => document.querySelector("#parts-list details.part-card [data-part-source]")?.offsetParent !== null,
			),
		).toBe(true);

		await ui.page.keyboard.press("Enter");
		expect(await isOpen(ui, "#parts-list details.part-card")).toBe(false);
	}, CASE_TIMEOUT_MS);

	it("case 15: details sections expand and collapse, and live stage blocks follow the run", async () => {
		// A running stage shows its transcript open; completing it collapses it.
		await ui.apply(SAMPLE_RUN_EVENTS.slice(0, 3));
		const live = '#live-generation [data-stage-live][data-stage="paraphrase"]';
		expect(await isOpen(ui, live)).toBe(true);
		expect(
			await ui.page.evaluate(
				sel => document.querySelector(`${sel} [data-stage-live-text]`)?.textContent ?? "",
				live,
			),
		).toContain("Build a login page");

		await ui.apply(SAMPLE_RUN_EVENTS.slice(3));
		expect(await isOpen(ui, live)).toBe(false);

		// Clicking a collapsed summary expands it; clicking again collapses it.
		await ui.page.click(`${live} > summary`);
		expect(await isOpen(ui, live)).toBe(true);
		await ui.page.click(`${live} > summary`);
		expect(await isOpen(ui, live)).toBe(false);

		// The Raw JSON disclosure behaves the same way and starts closed.
		await ui.page.click("#tab-raw");
		expect(await isOpen(ui, "#raw-json-details")).toBe(false);
		await ui.page.click("#raw-json-details > summary");
		expect(await isOpen(ui, "#raw-json-details")).toBe(true);
		expect(await ui.page.evaluate(() => document.querySelector("#raw-json-code")?.textContent ?? "")).toContain(
			SAMPLE_ANALYSIS.promptHash,
		);
	}, CASE_TIMEOUT_MS);

	it("case 16: Raw JSON copy puts the analysis on the clipboard and download writes the same JSON", async () => {
		const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-download-"));
		const cdp = await ui.browser.target().createCDPSession();
		await cdp.send("Browser.setDownloadBehavior", {
			behavior: "allow",
			downloadPath: downloadDir,
			eventsEnabled: true,
		});
		const settled = Promise.withResolvers<void>();
		cdp.on("Browser.downloadProgress", (progress: { state: string }) => {
			if (progress.state === "completed") settled.resolve();
			else if (progress.state === "canceled") settled.reject(new Error("download was canceled"));
		});
		await ui.browser
			.defaultBrowserContext()
			.overridePermissions(new URL(ui.page.url()).origin, ["clipboard-read", "clipboard-write"]);

		await ui.apply(SAMPLE_RUN_EVENTS);
		await ui.page.click("#tab-raw");
		await ui.page.click("#raw-json-details > summary");

		await ui.page.click("#raw-json-copy");
		await ui.page.waitForFunction(() => (document.querySelector("#raw-json-status")?.textContent ?? "").length > 0);
		const clipboard = await ui.page.evaluate(() => navigator.clipboard.readText());
		expect(JSON.parse(clipboard)).toEqual(SAMPLE_ANALYSIS);

		await ui.page.click("#raw-json-download");
		// Await Chrome's own completion signal rather than polling the directory.
		await settled.promise;
		const expected = `prompt-analysis-${SAMPLE_ANALYSIS.promptHash}.json`;
		const downloaded = await fs.readFile(path.join(downloadDir, expected), "utf8");
		expect(JSON.parse(downloaded)).toEqual(SAMPLE_ANALYSIS);
		await fs.rm(downloadDir, { recursive: true, force: true });
	}, CASE_TIMEOUT_MS);

	it("case 17: the assembled JSON is never the primary result view", async () => {
		await ui.apply(SAMPLE_RUN_EVENTS);

		// After a completed run the rendered Overview is what is selected.
		expect(await selectedTab(ui)).toBe("tab-overview");
		expect(await visiblePanels(ui)).toEqual(["panel-overview"]);
		expect(await ui.page.evaluate(() => document.querySelector("#overview-paraphrase")?.textContent ?? "")).toContain(
			"Build a login page",
		);

		// The Raw JSON panel is hidden and its disclosure collapsed, so no JSON
		// text is on screen anywhere.
		expect(await ui.page.evaluate(() => document.querySelector("#panel-raw")?.hasAttribute("hidden"))).toBe(true);
		expect(await isOpen(ui, "#raw-json-details")).toBe(false);
		const visibleText = await ui.page.evaluate(() => document.body.innerText);
		expect(visibleText).not.toContain('"promptHash"');
		expect(visibleText).not.toContain('"comparison"');
		// The human-readable rendering is what is visible instead.
		expect(visibleText).toContain("DIRECT");
		expect(visibleText).toContain("SOCIALIZE");
	}, CASE_TIMEOUT_MS);
});
