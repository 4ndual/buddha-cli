/**
 * Fixed registries for validation. A completed model result is rejected as final
 * unless every category, subcategory and question id appears here.
 */

/** The nine speech-act categories. Verbatim from the spec, order preserved. */
export const CATEGORIES = {
	INQUIRE: "asks for information or judgment",
	INFORM: "gives information, context, requirements or preferences",
	DIRECT: "requests new work or a result",
	PROPOSE: "introduces an idea or possibility",
	EVALUATE: "judges something",
	REVISE: "corrects or replaces previous meaning",
	AUTHORIZE: "approves, denies or permits something",
	CONTROL: "changes work already in progress",
	SOCIALIZE: "expresses a social or emotional message",
} as const;

export type Category = keyof typeof CATEGORIES;

/** Subcategories are category-scoped: a subcategory is invalid outside its parent. */
export const SUBCATEGORIES: Record<Category, readonly string[]> = {
	INQUIRE: ["factual_question", "status_question", "judgment_request", "clarification_request", "option_comparison"],
	INFORM: ["context", "requirement", "constraint", "preference", "observation", "correction_of_fact", "credential_or_reference"],
	DIRECT: ["build_request", "change_request", "investigate_request", "explain_request", "verify_request", "deliver_request"],
	PROPOSE: ["idea", "alternative", "hypothesis", "offer"],
	EVALUATE: ["approval", "criticism", "quality_judgment", "risk_judgment", "priority_judgment"],
	REVISE: ["technology_correction", "scope_correction", "instruction_correction", "retraction", "replacement"],
	AUTHORIZE: ["permission_granted", "permission_denied", "budget_approval", "scope_approval", "irreversible_action_approval"],
	CONTROL: ["stop", "pause", "resume", "redirect", "reprioritize", "cancel", "speed_or_effort_change"],
	SOCIALIZE: ["greeting", "thanks", "apology", "frustration", "encouragement", "smalltalk"],
};

/** Intent questions. INT-01 and INT-10 are ALWAYS evaluated; the rest load by category. */
export const INTENT_QUESTIONS: Record<string, { question: string; categories: readonly Category[] | "always" }> = {
	"INT-01": { question: "What did the user state or do?", categories: "always" },
	"INT-10": { question: "Which claims came from the user, model, tool or guideline?", categories: "always" },
	"INT-02": { question: "What information is being requested?", categories: ["INQUIRE"] },
	"INT-03": { question: "What new work or result is requested?", categories: ["DIRECT"] },
	"INT-04": { question: "What context, requirement or preference was supplied?", categories: ["INFORM"] },
	"INT-05": { question: "What idea or possibility was introduced?", categories: ["PROPOSE"] },
	"INT-06": { question: "What judgment was expressed, and about what?", categories: ["EVALUATE"] },
	"INT-07": { question: "What previous meaning was corrected or replaced?", categories: ["REVISE"] },
	"INT-08": { question: "What was approved, denied or permitted?", categories: ["AUTHORIZE"] },
	"INT-09": { question: "What in-progress work must change, and how?", categories: ["CONTROL"] },
	"INT-11": { question: "What constraint, prohibition or priority applies?", categories: ["INFORM", "DIRECT", "CONTROL"] },
	"INT-12": { question: "What dependency or action order was stated?", categories: ["DIRECT", "CONTROL"] },
	"INT-13": { question: "What social or emotional message was expressed?", categories: ["SOCIALIZE"] },
};

/** CTX-* questions are deliberately excluded from this writing MVP (they need task/agent state). */
export const EXCLUDED_QUESTION_PREFIX = "CTX-";

export function isCategory(value: string): value is Category {
	return Object.hasOwn(CATEGORIES, value);
}

export function isSubcategoryOf(category: string, subcategory: string): boolean {
	return isCategory(category) && SUBCATEGORIES[category].includes(subcategory);
}

/** Question ids activated by the detected category set, always including INT-01 and INT-10. */
export function activeQuestionIds(detected: readonly string[]): string[] {
	const set = new Set(detected.filter(isCategory));
	return Object.entries(INTENT_QUESTIONS)
		.filter(([, q]) => q.categories === "always" || q.categories.some(c => set.has(c)))
		.map(([id]) => id);
}
