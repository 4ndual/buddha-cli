/**
 * Registry and source-span enforcement: a stage result that invents a
 * category, or quotes text the user never wrote, must never become state.
 */
import { describe, expect, it } from "bun:test";
import { validateStage } from "../src/validate";
import { SIMPLE_PROMPT } from "./fixtures/prompts";

describe("validateStage", () => {
	it("case 9: rejects a category that is not in the fixed registry", () => {
		const accepted = validateStage(
			"categorize",
			{ parts: [{ text: SIMPLE_PROMPT, categories: ["DIRECT"] }] },
			{ rawPrompt: SIMPLE_PROMPT },
		);
		expect(accepted.ok).toBe(true);

		const rejected = validateStage(
			"categorize",
			{ parts: [{ text: SIMPLE_PROMPT, categories: ["BUILD_STUFF"] }] },
			{ rawPrompt: SIMPLE_PROMPT },
		);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.errors.some(error => error.includes("BUILD_STUFF"))).toBe(true);
	});

	it("case 10: rejects a source span that is not verbatim in the prompt", () => {
		const accepted = validateStage(
			"paraphrase",
			{
				paraphrase: "Build a login page.",
				parts: [{ source: SIMPLE_PROMPT, paraphrase: "Build a login page." }],
			},
			{ rawPrompt: SIMPLE_PROMPT },
		);
		expect(accepted.ok).toBe(true);

		const rejected = validateStage(
			"paraphrase",
			{
				paraphrase: "Build a login page and wire up OAuth.",
				parts: [{ source: "and wire up OAuth with Google", paraphrase: "Add Google sign-in." }],
			},
			{ rawPrompt: SIMPLE_PROMPT },
		);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.errors.some(error => error.includes("and wire up OAuth with Google"))).toBe(true);
	});
});
