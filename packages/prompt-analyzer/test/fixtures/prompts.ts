/**
 * One shared two-sentence prompt whose parts are exact substrings, so every
 * stage fixture can claim verbatim source spans that `validate.ts` accepts.
 *
 * Part A is a DIRECT act, part B is a SOCIALIZE act — the mixed-category case.
 */
export const PART_A = "Please build a login page with email and password fields.";
export const PART_B = "Thanks so much for turning the last one around so quickly!";
export const MIXED_PROMPT = `${PART_A} ${PART_B}`;

/** A single-act prompt, for tests that do not need two categories. */
export const SIMPLE_PROMPT = "Build a login page with email and password fields.";
