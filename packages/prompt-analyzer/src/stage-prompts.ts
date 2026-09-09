/**
 * The four stage system instructions, verbatim from the specification.
 * Treat these strings as a contract: do not reword, summarize or "improve" them.
 * Call 3 and 4 take runtime context appended as the user message, never here.
 */

export const PARAPHRASE_SYSTEM = `Rewrite the user's prompt in clearer, simpler language.

Preserve every request, question, correction, constraint, prohibition, priority, dependency and action order.

Do not add advice, assumptions or missing details.

Split the prompt only when separate parts express different meanings.

Return JSON only:

{
  "paraphrase": "clear paraphrase",
  "parts": [
    {
      "source": "exact source text",
      "paraphrase": "same meaning in simple language"
    }
  ]
}`;

export const CATEGORIZE_SYSTEM = `Split the user's message only when different parts perform different actions.

Assign every part one or more categories:

INQUIRE: asks for information or judgment
INFORM: gives information, context, requirements or preferences
DIRECT: requests new work or a result
PROPOSE: introduces an idea or possibility
EVALUATE: judges something
REVISE: corrects or replaces previous meaning
AUTHORIZE: approves, denies or permits something
CONTROL: changes work already in progress
SOCIALIZE: expresses a social or emotional message

Preserve the exact source text.
Do not paraphrase.
Do not invent meaning.
Do not force one category for the complete prompt.
A part may have several categories.

Return JSON only:

{
  "parts": [
    {
      "text": "exact source text",
      "categories": ["CATEGORY"],
      "references": ["exact words in this part that point to something outside this message"]
    }
  ],
  "needs_context": true
}`;

export const ANALYZE_SYSTEM = `Analyze the supplied prompt parts using only the allowed subcategories and the activated intent questions given in the user message.

Preserve the exact source text. Do not paraphrase. Do not invent meaning.
Use only subcategories listed for that part's categories.
Answer only the intent questions supplied. Every intent answer needs exact supporting source text.

Return JSON only:

{
  "parts": [
    {
      "text": "exact source text",
      "subcategories": ["subcategory"],
      "tags": ["short-tag"]
    }
  ],
  "intent": [
    {
      "id": "INT-01",
      "answer": "short answer",
      "source": "exact supporting source text"
    }
  ]
}`;

export const VERIFY_SYSTEM = `Verify the proposed analysis against the raw prompt.

Check whether:

1. The paraphrase preserves every meaning.
2. Any request, question, correction, constraint, prohibition, priority, dependency or action order was lost.
3. The paraphrase invented meaning.
4. Categories match the source actions.
5. Subcategories belong to their categories.
6. Intent answers have exact source support.
7. The complete result contradicts itself.

Do not rewrite or silently repair the analysis.

Return JSON only:

{
  "category_match": true,
  "subcategory_match": true,
  "meaning_coverage": 1,
  "invented_meaning_count": 0,
  "lost_meaning_count": 0,
  "coherent": true,
  "problems": []
}`;
