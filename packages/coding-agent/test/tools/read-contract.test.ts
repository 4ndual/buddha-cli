import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import { EditTool } from "../../src/edit";
import { getEditStore } from "../../src/edit/store";
import type { ToolSession } from "../../src/sdk";
import { readSchema, ReadTool } from "../../src/tools/read";

function session(cwd: string, overrides: Record<string, unknown> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "read.summarize.enabled": false, ...overrides }),
	};
}

function text(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

describe("read contract", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-contract-"));
		await Promise.all([
			fs.writeFile(path.join(cwd, "a.txt"), "a1\na2\na3\na4\n"),
			fs.writeFile(path.join(cwd, "b.txt"), "b1\nb2\nb3\n"),
		]);
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("keeps legacy path input and rejects illegal structured states", () => {
		expect(readSchema.parse({ path: "a.txt" })).toEqual({ path: "a.txt" });
		expect(() => readSchema.parse({ path: "a.txt", targets: [{ path: "b.txt" }] })).toThrow();
		expect(() => readSchema.parse({ targets: [{ path: "a.txt" }] })).toThrow();
		expect(() => readSchema.parse({ path: "a.txt", selection: { mode: "lines", ranges: [] } })).toThrow();
	});

	it("maps structured selectors onto the existing selector engine", async () => {
		const result = await new ReadTool(session(cwd)).execute("structured", {
			path: "a.txt",
			selection: { mode: "lines", ranges: ["2-3"] },
		});
		expect(text(result)).toContain("a2");
		expect(text(result)).toContain("a3");
	});

	it("runs bounded batches and preserves target order", async () => {
		const result = await new ReadTool(session(cwd)).execute("batch", {
			targets: [
				{ path: "a.txt", selection: { mode: "lines", ranges: ["1"] } },
				{ path: "b.txt", selection: { mode: "lines", ranges: ["2"] } },
			],
			concurrency: 2,
		});
		const output = text(result);
		expect(output.indexOf("## a.txt")).toBeLessThan(output.indexOf("## b.txt"));
		expect(output).toContain("a1");
		expect(output).toContain("b2");
		expect(result.details?.batch?.map(entry => entry.ok)).toEqual([true, true]);
	});

	it("returns a machine-readable continuation", async () => {
		const result = await new ReadTool(session(cwd, { "read.defaultLimit": 2 })).execute("continue", {
			path: "a.txt",
		});
		expect(result.details?.continuation).toEqual({ path: "a.txt", selector: "3-" });
	});

	it("enables exact seen-line enforcement by default", () => {
		expect(Settings.isolated().get("edit.enforceSeenLines")).toBe(true);
	});

	it("rejects hashline edits outside the lines displayed by read", async () => {
		const source = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
		await fs.writeFile(path.join(cwd, "guarded.txt"), source);
		const toolSession = session(cwd, { "edit.mode": "hashline" });
		const read = await new ReadTool(toolSession).execute("seed", {
			path: "guarded.txt",
			selection: { mode: "lines", ranges: ["1-1"] },
		});
		const header = text(read).match(/^\[guarded\.txt#[0-9A-F]{4}\]$/m)?.[0];
		expect(header).toBeDefined();
		const tag = header?.match(/#([0-9A-F]{4})\]$/)?.[1];
		expect(tag).toBeDefined();
		expect(getEditStore(toolSession).seenLines(path.join(cwd, "guarded.txt"), tag!)).not.toContain(150);
		const result = await new EditTool(toolSession, "hashline").execute("unseen", {
			input: `${header}\nPUT 150-150:\n+replacement`,
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/not (?:seen|displayed)|read.*line/i);
	});
});
