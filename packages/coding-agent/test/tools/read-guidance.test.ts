import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function createSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("Read capability discovery", () => {
	it("advertises automatic routing, summaries, selectors, and batches compactly", () => {
		const description = new ReadTool(createSession()).description;

		expect(description).toContain("archives, SQLite, documents, images, videos");
		expect(description).toContain("ordinary web URLs");
		expect(description).toContain("exact recovery ranges");
		expect(description).toContain("structured selectors and bounded parallel batches");
	});
});
