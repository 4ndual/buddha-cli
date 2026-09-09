/**
 * Context Reference neuron - shared contracts.
 *
 * The second permanent neuron beside Category. Category asks "what is the user
 * doing"; Context asks "what is the user referring to". Categories cannot
 * replace reference resolution: "Do that again, but use the other one" is
 * DIRECT + REVISE, and both labels are useless until `that` and `the other one`
 * resolve.
 *
 * Detection NEVER resolves. The detector reports references; the resolver
 * retrieves. Keeping them apart is what allows detection to run in parallel
 * with paraphrase and categorization while only final interpretation waits.
 */

/** Where a reference can point. Ordered cheapest-to-retrieve first. */
export const REFERENCE_SOURCES = [
	"last_turn",
	"earlier_message",
	"previous_decision",
	"active_task",
	"named_project",
	"agent_or_person",
	"file_or_artifact",
	"image_or_attachment",
	"link",
	"current_environment",
	"external_information",
	"unknown",
] as const;

export type ReferenceSource = (typeof REFERENCE_SOURCES)[number];

export function isReferenceSource(value: unknown): value is ReferenceSource {
	return typeof value === "string" && (REFERENCE_SOURCES as readonly string[]).includes(value);
}

/**
 * `material` gates interpretation, `incidental` does not.
 *
 * A reference is material when resolving it changes what the assistant would
 * do. "the input side" in "nope i mean the input side" is material - the wrong
 * binding sends the whole answer to the wrong subsystem. "Thanks for the quick
 * turnaround" carries a reference to prior work that changes nothing.
 */
export type ReferenceWeight = "material" | "incidental";

export interface DetectedReference {
	/** The referring words, verbatim from the prompt. */
	readonly text: string;
	/** What the detector believes it points to, or null when it cannot say. */
	readonly pointsTo: string | null;
	/** Best guess at where the answer lives, or null. */
	readonly source: ReferenceSource | null;
	readonly weight: ReferenceWeight;
}

/** Wave-0 detector output. Never contains retrieved content. */
export interface ContextDetection {
	readonly needsContext: boolean;
	readonly references: readonly DetectedReference[];
	/** Prompt is self-contained: no reference of any weight. */
	readonly selfContained: boolean;
}

/** A reference after the resolver has had its turn. */
export interface ResolvedReference extends DetectedReference {
	readonly resolved: boolean;
	/** Retrieved text supporting the binding, empty when unresolved. */
	readonly evidence: string;
	/** Which retrieval tier produced it; null when unresolved. */
	readonly resolvedByTier: number | null;
}

/**
 * Confidence is the material-reference resolution ratio, as a percentage.
 *
 * Incidental references are excluded from both numerator and denominator: an
 * unresolved pleasantry must never hold up interpretation. A prompt with no
 * material references is 100 by definition - nothing is missing.
 */
export function contextConfidence(refs: readonly ResolvedReference[]): number {
	const material = refs.filter(r => r.weight === "material");
	if (material.length === 0) return 100;
	const resolved = material.filter(r => r.resolved).length;
	return Math.round((resolved / material.length) * 100);
}

/**
 * The threshold from the design sketch: 90% confidence is enough context.
 * At or above it, interpretation proceeds; below it, retrieval escalates.
 */
export const CONFIDENCE_THRESHOLD = 90;

/** Hard ceiling on simultaneous retrieval agents. */
export const MAX_RETRIEVAL_FANOUT = 6;

/**
 * How many parallel retrievers to launch for a given confidence.
 *
 * One agent per 10 points of missing confidence, clamped to the ceiling. This
 * makes the sketch's bands fall out of arithmetic instead of a lookup table:
 * 90+ -> 0, 80s -> 1, 70s -> 2, 60s -> 3, 50s -> 4, 40s -> 5, below -> 6.
 * Cheap prompts stay cheap; a prompt referring to five unknown things gets the
 * fleet.
 */
export function retrievalFanout(confidence: number): number {
	if (confidence >= CONFIDENCE_THRESHOLD) return 0;
	const deficit = CONFIDENCE_THRESHOLD - confidence;
	return Math.min(MAX_RETRIEVAL_FANOUT, Math.ceil(deficit / 10));
}

/** Retrieval tiers, cheapest first. Tier 0 costs no model call and no agent. */
export interface RetrievalTier {
	readonly tier: number;
	readonly name: string;
	/** Sources this tier can bind. */
	readonly sources: readonly ReferenceSource[];
	/** True when the tier is pure lookup over material already in hand. */
	readonly free: boolean;
}

export const RETRIEVAL_TIERS: readonly RetrievalTier[] = [
	{
		tier: 0,
		name: "in-hand",
		sources: ["last_turn", "current_environment"],
		free: true,
	},
	{
		tier: 1,
		name: "topic+glossary",
		sources: ["active_task", "named_project", "agent_or_person"],
		free: true,
	},
	{
		tier: 2,
		name: "conversation tgrep",
		sources: ["earlier_message", "previous_decision"],
		free: false,
	},
	{
		tier: 3,
		name: "artifacts+files",
		sources: ["file_or_artifact", "image_or_attachment", "link"],
		free: false,
	},
	{
		tier: 4,
		name: "external",
		sources: ["external_information", "unknown"],
		free: false,
	},
];

/** Cap on the rolling topic digest, per the design sketch. */
export const TOPIC_DIGEST_CHARS = 240;

/** One autogenerated glossary entry: a term the conversation established. */
export interface GlossaryEntry {
	readonly term: string;
	/** At most TOPIC_DIGEST_CHARS, so the glossary stays a cheap first hop. */
	readonly definition: string;
	/** 1-based index of the turn that established the term. */
	readonly turnIndex: number;
}

/** Outcome of the escalation ladder for one prompt. */
export interface ContextResolution {
	readonly references: readonly ResolvedReference[];
	readonly confidence: number;
	/** Highest tier actually executed. */
	readonly tiersUsed: number;
	/** Retrievers launched, summed across tiers. */
	readonly retrieversLaunched: number;
	/**
	 * True when interpretation may proceed: confidence met the threshold, or
	 * the ladder is exhausted and the caller accepted a documented gap.
	 */
	readonly safeToContinue: boolean;
	/** Material references still unbound after the ladder ran out. */
	readonly unresolvedMaterial: readonly string[];
}
