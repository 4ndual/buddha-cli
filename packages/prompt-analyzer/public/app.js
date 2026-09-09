/**
 * Buddha Prompt Analyzer — browser client.
 *
 * Knows exactly two things about the outside world:
 *   1. a WebSocket at same-origin `/ws`
 *   2. the `AnalysisEvent` union from src/contracts.ts
 * No OMP protocol knowledge, no model provider access, no timers driving calls.
 */

/* ------------------------------------------------------------------ mirror
 * Presentation strings mirrored from src/registry.ts. Display only — all
 * validation lives in the backend (src/validate.ts). Keep in sync with
 * src/registry.ts if the registry ever gains or renames a question/category.
 * -------------------------------------------------------------------------- */

const QUESTION_TEXT = {
	"INT-01": "What did the user state or do?",
	"INT-02": "What information is being requested?",
	"INT-03": "What new work or result is requested?",
	"INT-04": "What context, requirement or preference was supplied?",
	"INT-05": "What idea or possibility was introduced?",
	"INT-06": "What judgment was expressed, and about what?",
	"INT-07": "What previous meaning was corrected or replaced?",
	"INT-08": "What was approved, denied or permitted?",
	"INT-09": "What in-progress work must change, and how?",
	"INT-10": "Which claims came from the user, model, tool or guideline?",
	"INT-11": "What constraint, prohibition or priority applies?",
	"INT-12": "What dependency or action order was stated?",
	"INT-13": "What social or emotional message was expressed?",
};

const CATEGORY_DESC = {
	INQUIRE: "asks for information or judgment",
	INFORM: "gives information, context, requirements or preferences",
	DIRECT: "requests new work or a result",
	PROPOSE: "introduces an idea or possibility",
	EVALUATE: "judges something",
	REVISE: "corrects or replaces previous meaning",
	AUTHORIZE: "approves, denies or permits something",
	CONTROL: "changes work already in progress",
	SOCIALIZE: "expresses a social or emotional message",
};

const CATEGORY_VAR = {
	INQUIRE: "--cat-inquire",
	INFORM: "--cat-inform",
	DIRECT: "--cat-direct",
	PROPOSE: "--cat-propose",
	EVALUATE: "--cat-evaluate",
	REVISE: "--cat-revise",
	AUTHORIZE: "--cat-authorize",
	CONTROL: "--cat-control",
	SOCIALIZE: "--cat-socialize",
};

const STAGES = ["paraphrase", "categorize", "analyze", "verify"];
const STAGE_LABEL = {
	paraphrase: "Paraphrase",
	categorize: "Categorize",
	analyze: "Analyze",
	verify: "Verify",
};

/** Below this a fragment is treated as still being typed, never auto-analyzed. */
const MIN_AUTO_CHARS = 12;
/** A paste this large is intent enough on its own. */
const PASTE_TRIGGER_CHARS = 20;

/* ------------------------------------------------------------------- dom */

const $ = id => document.getElementById(id);

const el = {
	prompt: $("prompt-input"),
	analyze: $("analyze-now"),
	retryGlobal: $("retry-global"),
	runStatus: $("run-status"),
	connStatus: $("conn-status"),
	connText: $("conn-status-text"),
	modelBadge: $("model-badge"),
	live: $("live-generation"),
	notices: $("run-notices"),
	tablist: document.querySelector(".tablist"),
	tabs: Array.from(document.querySelectorAll('[role="tab"]')),
	panels: Array.from(document.querySelectorAll('[role="tabpanel"]')),
	overviewParaphrase: $("overview-paraphrase"),
	overviewCategories: $("overview-categories"),
	overviewTags: $("overview-tags"),
	overviewMeterFill: $("overview-meter-fill"),
	overviewMeterValue: $("overview-meter-value"),
	overviewMeterWrap: $("overview-meter-wrap"),
	overviewState: $("overview-state"),
	partsList: $("parts-list"),
	intentList: $("intent-list"),
	verification: $("verification-content"),
	rawDetails: $("raw-json-details"),
	rawCode: $("raw-json-code"),
	rawCopy: $("raw-json-copy"),
	rawDownload: $("raw-json-download"),
	rawStatus: $("raw-json-status"),
	tmplStageLive: $("tmpl-stage-live"),
	tmplPartCard: $("tmpl-part-card"),
	tmplIntentCard: $("tmpl-intent-card"),
	tmplProblemCard: $("tmpl-problem-card"),
};

/* ----------------------------------------------------------------- state */

const state = {
	socket: null,
	connected: false,
	/** rawPrompt of the newest request the user triggered. */
	pendingPrompt: "",
	/** sha256(pendingPrompt) — the only hash allowed to own the visible result. */
	currentHash: "",
	/** runId the server assigned to `currentHash`; null until run_started. */
	currentRunId: null,
	/** runId -> promptHash, for stale/cancel bookkeeping of superseded runs. */
	runHashes: new Map(),
	/** Last text we actually sent, for dedupe across overlapping triggers. */
	lastSentPrompt: null,
	stages: {},
	view: emptyView(),
	analysis: null,
	activeTab: "overview",
	lastTrigger: null,
};

function emptyView() {
	return { paraphrase: "", parts: [], intent: [], comparison: null, categories: [], tags: [] };
}

function resetStages() {
	state.stages = {};
	for (const stage of STAGES) {
		state.stages[stage] = { state: "pending", text: "", startedAt: 0, ms: 0, error: "" };
	}
}
resetStages();

/* ------------------------------------------------------------- utilities */

const norm = s => String(s ?? "").replace(/\s+/g, " ").trim();

async function sha256Hex12(text) {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map(b => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 12);
}

function humanize(value) {
	return String(value ?? "").replace(/_/g, " ");
}

function truncate(text, max = 120) {
	const flat = norm(text);
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clearNode(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
}

function categoryBadge(category) {
	const span = document.createElement("span");
	span.className = "badge badge--category";
	span.textContent = category;
	const varName = CATEGORY_VAR[category];
	if (varName) span.style.setProperty("--cat", `var(${varName})`);
	if (CATEGORY_DESC[category]) span.title = `${category} — ${CATEGORY_DESC[category]}`;
	return span;
}

function subBadge(sub, category) {
	const span = document.createElement("span");
	span.className = "badge badge--sub";
	span.textContent = humanize(sub);
	if (category) span.title = `${category} · ${humanize(sub)}`;
	return span;
}

function tagBadge(tag) {
	const span = document.createElement("span");
	span.className = "badge badge--tag";
	span.textContent = String(tag);
	return span;
}

function fillBadges(container, values, make) {
	clearNode(container);
	for (const value of values) container.appendChild(make(value));
}

function setPanel(name, hasContent) {
	const panel = document.querySelector(`[data-panel="${name}"]`);
	if (!panel) return;
	const empty = panel.querySelector("[data-empty]");
	const content = panel.querySelector("[data-content]");
	if (empty) empty.hidden = hasContent;
	if (content) content.hidden = !hasContent;
}

function setStatus(text, tone) {
	el.runStatus.textContent = text;
	if (tone) el.runStatus.dataset.tone = tone;
	else delete el.runStatus.dataset.tone;
}

function setConnection(kind, text) {
	el.connStatus.className = `status-dot status-dot--${kind}`;
	el.connText.textContent = text;
}

function setTabCount(tab, count) {
	const button = document.querySelector(`[data-tab="${tab}"]`);
	if (!button) return;
	let badge = button.querySelector(".tab__count");
	if (count === null || count === undefined) {
		if (badge) badge.remove();
		return;
	}
	if (!badge) {
		badge = document.createElement("span");
		badge.className = "tab__count";
		button.appendChild(badge);
	}
	badge.textContent = String(count);
}

/* ------------------------------------------------------------------ tabs */

function selectTab(name, { focus = false } = {}) {
	state.activeTab = name;
	for (const tab of el.tabs) {
		const selected = tab.dataset.tab === name;
		tab.setAttribute("aria-selected", selected ? "true" : "false");
		tab.tabIndex = selected ? 0 : -1;
		if (selected && focus) tab.focus();
	}
	for (const panel of el.panels) {
		panel.hidden = panel.dataset.panel !== name;
	}
}

el.tablist.addEventListener("click", event => {
	const tab = event.target.closest('[role="tab"]');
	if (tab) selectTab(tab.dataset.tab);
});

el.tablist.addEventListener("keydown", event => {
	const index = el.tabs.findIndex(t => t === document.activeElement);
	if (index < 0) return;
	let next = -1;
	if (event.key === "ArrowRight") next = (index + 1) % el.tabs.length;
	else if (event.key === "ArrowLeft") next = (index - 1 + el.tabs.length) % el.tabs.length;
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = el.tabs.length - 1;
	if (next < 0) return;
	event.preventDefault();
	selectTab(el.tabs[next].dataset.tab, { focus: true });
});

/** Superseded / cancelled runs stay on screen: the user must see why results vanished. */
function noteRun(kind, text) {
	const item = document.createElement("li");
	item.className = "run-notice";
	item.dataset.kind = kind;
	const label = document.createElement("span");
	label.className = "run-notice__label";
	label.textContent = kind;
	const body = document.createElement("span");
	body.textContent = text;
	item.append(label, body);
	el.notices.prepend(item);
	while (el.notices.children.length > 4) el.notices.lastElementChild.remove();
}

/* ---------------------------------------------------------- live streams */

function stageBlock(stage) {
	let block = el.live.querySelector(`[data-stage-live][data-stage="${stage}"]`);
	if (block) return block;
	const frag = el.tmplStageLive.content.cloneNode(true);
	block = frag.querySelector("[data-stage-live]");
	block.dataset.stage = stage;
	block.querySelector("[data-stage-live-name]").textContent = STAGE_LABEL[stage];
	block.querySelector("[data-stage-live-retry]").addEventListener("click", () => {
		retry(`stage:${stage}`);
	});
	// Keep the strip in pipeline order regardless of completion order.
	const order = STAGES.indexOf(stage);
	const after = Array.from(el.live.children).find(child => STAGES.indexOf(child.dataset.stage) > order);
	el.live.insertBefore(block, after ?? null);
	return block;
}

function paintStage(stage) {
	const s = state.stages[stage];
	const chip = document.querySelector(`.stage-chip[data-stage="${stage}"]`);
	if (chip) chip.dataset.state = s.state;
	const block = el.live.querySelector(`[data-stage-live][data-stage="${stage}"]`);
	if (!block) return;
	block.dataset.state = s.state;
	const status = block.querySelector("[data-stage-live-status]");
	if (s.state === "active") status.textContent = "streaming…";
	else if (s.state === "completed") status.textContent = `completed · ${s.ms} ms`;
	else if (s.state === "failed") status.textContent = "failed";
	else if (s.state === "stale") status.textContent = "superseded";
	else status.textContent = "";
	const errorBox = block.querySelector("[data-stage-live-error]");
	errorBox.hidden = s.state !== "failed";
	if (s.state === "failed") {
		block.querySelector("[data-stage-live-error-text]").textContent = s.error;
	}
}

function clearLive() {
	clearNode(el.live);
	resetStages();
	for (const stage of STAGES) {
		const chip = document.querySelector(`.stage-chip[data-stage="${stage}"]`);
		if (chip) chip.dataset.state = "pending";
	}
}

function markStagesStale() {
	for (const stage of STAGES) {
		const s = state.stages[stage];
		if (s.state === "active" || s.state === "pending") s.state = "stale";
		paintStage(stage);
	}
}

/* ------------------------------------------------------------- rendering */

function pipelineLabel() {
	if (state.analysis) return "verified";
	const active = STAGES.find(s => state.stages[s].state === "active");
	if (active) return `${STAGE_LABEL[active].toLowerCase()} running`;
	if (STAGES.some(s => state.stages[s].state === "failed")) return "failed";
	if (STAGES.some(s => state.stages[s].state === "stale")) return "superseded";
	if (STAGES.every(s => state.stages[s].state === "pending")) return "idle";
	return "working";
}

function renderOverview() {
	const v = state.view;
	const has = Boolean(v.paraphrase || v.parts.length || v.categories.length);
	setPanel("overview", has);
	if (!has) return;

	el.overviewParaphrase.textContent = v.paraphrase || "Paraphrase not produced yet.";
	fillBadges(el.overviewCategories, v.categories, categoryBadge);
	fillBadges(el.overviewTags, v.tags, tagBadge);

	const coverage = v.comparison ? v.comparison.meaningCoverage : null;
	if (typeof coverage === "number") {
		const pct = Math.round(coverage <= 1 ? coverage * 100 : coverage);
		el.overviewMeterFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
		el.overviewMeterFill.dataset.tone = pct >= 90 ? "ok" : "warn";
		el.overviewMeterValue.textContent = `${pct}%`;
		el.overviewMeterWrap.setAttribute("aria-label", `Meaning match ${pct} percent`);
	} else {
		el.overviewMeterFill.style.width = "0%";
		el.overviewMeterValue.textContent = "—";
		el.overviewMeterWrap.setAttribute("aria-label", "Meaning match not measured yet");
	}

	const label = pipelineLabel();
	el.overviewState.textContent = label;
	el.overviewState.className = `pill ${
		label === "verified" ? "pill--ok" : label === "failed" ? "pill--danger" : label === "superseded" ? "pill--warn" : label === "idle" ? "pill--neutral" : "pill--active"
	}`;
}

function intentForPart(part) {
	const source = norm(part.source).toLowerCase();
	if (!source) return [];
	return state.view.intent.filter(answer => {
		const answerSource = norm(answer.source).toLowerCase();
		if (!answerSource) return false;
		return answerSource === source || source.includes(answerSource) || answerSource.includes(source);
	});
}

function renderParts() {
	const parts = state.view.parts;
	setPanel("parts", parts.length > 0);
	setTabCount("parts", parts.length || null);
	clearNode(el.partsList);
	if (!parts.length) return;

	for (const part of parts) {
		const frag = el.tmplPartCard.content.cloneNode(true);
		const card = frag.querySelector("details");
		const categories = part.categories ?? [];
		const subcategories = part.subcategories ?? [];
		const tags = part.tags ?? [];

		fillBadges(card.querySelector("[data-part-categories]"), categories, categoryBadge);
		fillBadges(card.querySelector("[data-part-categories-full]"), categories, categoryBadge);
		fillBadges(card.querySelector("[data-part-subcategories]"), subcategories.slice(0, 3), s => subBadge(s, categories[0]));
		fillBadges(card.querySelector("[data-part-subcategories-full]"), subcategories, s => subBadge(s, categories[0]));
		fillBadges(card.querySelector("[data-part-tags]"), tags, tagBadge);

		card.querySelector("[data-part-preview]").textContent = truncate(part.source, 110);
		card.querySelector("[data-part-source]").textContent = part.source ?? "";
		card.querySelector("[data-part-paraphrase]").textContent = part.paraphrase || "—";

		const linked = intentForPart(part);
		const field = card.querySelector("[data-part-intent-field]");
		const list = card.querySelector("[data-part-intent-list]");
		if (linked.length) {
			field.hidden = false;
			for (const answer of linked) {
				const row = document.createElement("div");
				row.className = "mini-intent";
				const head = document.createElement("div");
				head.className = "mini-intent__head";
				const id = document.createElement("span");
				id.className = "pill pill--id";
				id.textContent = answer.id;
				const question = document.createElement("span");
				question.className = "mini-intent__question";
				question.textContent = QUESTION_TEXT[answer.id] ?? "";
				head.append(id, question);
				const text = document.createElement("p");
				text.className = "mini-intent__answer";
				text.textContent = answer.answer;
				row.append(head, text);
				list.appendChild(row);
			}
		}
		el.partsList.appendChild(frag);
	}
}

function renderIntent() {
	// Group by question id; unanswered questions are never shown.
	const groups = new Map();
	for (const answer of state.view.intent) {
		if (!answer || !answer.id || !String(answer.answer ?? "").trim()) continue;
		if (!groups.has(answer.id)) groups.set(answer.id, []);
		groups.get(answer.id).push(answer);
	}
	const ids = Array.from(groups.keys()).sort();
	setPanel("intent", ids.length > 0);
	setTabCount("intent", ids.length || null);
	clearNode(el.intentList);
	if (!ids.length) return;

	for (const id of ids) {
		for (const answer of groups.get(id)) {
			const frag = el.tmplIntentCard.content.cloneNode(true);
			const card = frag.querySelector("details");
			card.querySelector("[data-intent-id]").textContent = id;
			card.querySelector("[data-intent-question]").textContent = QUESTION_TEXT[id] ?? "(question not in registry)";
			card.querySelector("[data-intent-answer]").textContent = answer.answer;
			const source = card.querySelector("[data-intent-source]");
			source.textContent = answer.source || "—";
			el.intentList.appendChild(frag);
		}
	}
}

function checkCard(label, value, tone, note) {
	const card = document.createElement("div");
	card.className = "check-card";
	const l = document.createElement("span");
	l.className = "check-card__label";
	l.textContent = label;
	const v = document.createElement("span");
	v.className = "check-card__value";
	v.dataset.tone = tone;
	v.textContent = value;
	card.append(l, v);
	if (note) {
		const n = document.createElement("span");
		n.className = "check-card__note";
		n.textContent = note;
		card.appendChild(n);
	}
	return card;
}

function renderVerification() {
	const c = state.view.comparison;
	setPanel("verification", Boolean(c));
	setTabCount("verification", c && c.problems ? c.problems.length || null : null);
	if (!c) return;
	clearNode(el.verification);

	const banner = document.createElement("div");
	banner.className = "verification__banner";
	banner.dataset.state = c.coherent ? "coherent" : "incomplete";
	const icon = document.createElement("span");
	icon.className = "verification__banner-icon";
	// Static inline SVG, not a glyph: geometric font coverage is not guaranteed.
	icon.innerHTML = c.coherent
		? '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M6 10.5l2.6 2.6L14.2 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
		: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M10 5.5v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1.05" fill="currentColor"/></svg>';
	icon.style.color = c.coherent ? "var(--ok)" : "var(--warn)";
	const textWrap = document.createElement("div");
	const title = document.createElement("p");
	title.className = "verification__banner-title";
	title.textContent = c.coherent ? "Analysis is coherent with the prompt" : "Analysis is incomplete";
	const note = document.createElement("p");
	note.className = "verification__banner-note";
	note.textContent = c.coherent
		? "Every part of the prompt is represented and nothing was invented."
		: "The verifier found meaning that is missing, invented or contradictory.";
	textWrap.append(title, note);
	banner.append(icon, textWrap);
	el.verification.appendChild(banner);

	const grid = document.createElement("div");
	grid.className = "verification__grid";
	const pct = typeof c.meaningCoverage === "number" ? Math.round(c.meaningCoverage <= 1 ? c.meaningCoverage * 100 : c.meaningCoverage) : null;
	grid.append(
		checkCard("Category match", c.categoryMatch ? "match" : "mismatch", c.categoryMatch ? "ok" : "danger", c.categoryMatch ? "Categories agree with the raw prompt" : "Categories disagree with the raw prompt"),
		checkCard("Subcategory match", c.subcategoryMatch ? "match" : "mismatch", c.subcategoryMatch ? "ok" : "danger", c.subcategoryMatch ? "Subcategories are valid for their parent" : "A subcategory does not fit its category"),
		checkCard("Meaning coverage", pct === null ? "—" : `${pct}%`, pct === null ? "neutral" : pct >= 90 ? "ok" : "warn", "Share of the prompt's meaning preserved"),
		checkCard("Lost meaning", String(c.lostMeaningCount ?? 0), (c.lostMeaningCount ?? 0) === 0 ? "ok" : "warn", "Meaning present in the prompt but absent from the analysis"),
		checkCard("Invented meaning", String(c.inventedMeaningCount ?? 0), (c.inventedMeaningCount ?? 0) === 0 ? "ok" : "danger", "Meaning in the analysis with no source in the prompt"),
		checkCard("Final state", c.coherent ? "coherent" : "incomplete", c.coherent ? "ok" : "warn", "Verifier verdict for this run"),
	);
	el.verification.appendChild(grid);

	const problems = Array.isArray(c.problems) ? c.problems : [];
	const section = document.createElement("div");
	section.className = "verification__problems";
	const heading = document.createElement("h3");
	heading.textContent = problems.length ? `Contradictions and gaps (${problems.length})` : "Contradictions and gaps";
	section.appendChild(heading);
	if (!problems.length) {
		const none = document.createElement("p");
		none.className = "check-card__note";
		none.textContent = "None reported.";
		section.appendChild(none);
	} else {
		const list = document.createElement("ul");
		list.className = "problems-list";
		for (const problem of problems) {
			const frag = el.tmplProblemCard.content.cloneNode(true);
			const item = frag.querySelector("li");
			const type = String(problem.type ?? "problem");
			item.dataset.problemSeverity = /lost|missing|coverage/i.test(type) ? "warn" : "error";
			item.querySelector("[data-problem-type]").textContent = humanize(type);
			item.querySelector("[data-problem-message]").textContent = problem.message ?? "";
			const source = item.querySelector("[data-problem-source]");
			if (problem.source) {
				source.hidden = false;
				source.textContent = problem.source;
			}
			list.appendChild(frag);
		}
		section.appendChild(list);
	}
	el.verification.appendChild(section);
}

function highlightJson(json) {
	const escaped = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return escaped.replace(
		/("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b)|(\bnull\b)|([{}\[\],])/g,
		(match, key, str, num, bool, nul, punct) => {
			if (key) return `<span class="tok-key">${key}</span>`;
			if (str) return `<span class="tok-string">${str}</span>`;
			if (num) return `<span class="tok-number">${num}</span>`;
			if (bool) return `<span class="tok-bool">${bool}</span>`;
			if (nul) return `<span class="tok-null">${nul}</span>`;
			return `<span class="tok-punct">${punct}</span>`;
		},
	);
}

function renderRaw() {
	const has = Boolean(state.analysis);
	setPanel("raw", has);
	if (!has) {
		el.rawDetails.open = false;
		el.rawCode.textContent = "";
		return;
	}
	const json = JSON.stringify(state.analysis, null, 2);
	el.rawCode.innerHTML = highlightJson(json);
	el.rawCode.dataset.json = "";
	// Never auto-open: diagnostic data stays collapsed until asked for.
}

function renderAll() {
	renderOverview();
	renderParts();
	renderIntent();
	renderVerification();
	renderRaw();
}

/* -------------------------------------------------------- stage results */

function categoriesOf(parts) {
	const seen = [];
	for (const part of parts) {
		for (const category of part.categories ?? []) {
			if (!seen.includes(category)) seen.push(category);
		}
	}
	return seen;
}

function tagsOf(parts) {
	const seen = [];
	for (const part of parts) {
		for (const tag of part.tags ?? []) {
			if (!seen.includes(tag)) seen.push(tag);
		}
	}
	return seen;
}

/** Merge a completed stage result into the view model. Complete results only. */
function applyStageResult(stage, result) {
	if (!result || typeof result !== "object") return;
	const v = state.view;

	if (stage === "paraphrase") {
		if (typeof result.paraphrase === "string") v.paraphrase = result.paraphrase;
		if (Array.isArray(result.parts)) {
			v.parts = result.parts.map(p => ({
				source: p.source ?? p.text ?? "",
				paraphrase: p.paraphrase ?? "",
				categories: [],
				subcategories: [],
				tags: [],
			}));
		}
	}

	if (stage === "categorize" && Array.isArray(result.parts)) {
		const incoming = result.parts.map(p => ({
			source: p.text ?? p.source ?? "",
			categories: Array.isArray(p.categories) ? p.categories : [],
		}));
		if (!v.parts.length) {
			v.parts = incoming.map(p => ({ ...p, paraphrase: "", subcategories: [], tags: [] }));
		} else {
			for (const part of v.parts) {
				const match = incoming.find(p => norm(p.source) === norm(part.source))
					?? incoming.find(p => norm(p.source).includes(norm(part.source)) || norm(part.source).includes(norm(p.source)));
				if (match) part.categories = match.categories;
			}
			for (const p of incoming) {
				if (!v.parts.some(part => norm(part.source) === norm(p.source))) {
					v.parts.push({ source: p.source, paraphrase: "", categories: p.categories, subcategories: [], tags: [] });
				}
			}
		}
		v.categories = categoriesOf(v.parts);
	}

	if (stage === "analyze") {
		if (Array.isArray(result.parts)) {
			v.parts = result.parts.map(p => {
				const previous = v.parts.find(x => norm(x.source) === norm(p.source ?? p.text ?? ""));
				return {
					source: p.source ?? p.text ?? "",
					paraphrase: p.paraphrase ?? previous?.paraphrase ?? "",
					categories: Array.isArray(p.categories) ? p.categories : previous?.categories ?? [],
					subcategories: Array.isArray(p.subcategories) ? p.subcategories : [],
					tags: Array.isArray(p.tags) ? p.tags : [],
				};
			});
		}
		if (Array.isArray(result.intent)) {
			v.intent = result.intent.map(a => ({ id: a.id ?? "", answer: a.answer ?? "", source: a.source ?? "" }));
		}
		v.categories = categoriesOf(v.parts);
		v.tags = tagsOf(v.parts);
	}

	if (stage === "verify") {
		const comparison = result.comparison && typeof result.comparison === "object" ? result.comparison : result;
		if (typeof comparison.coherent === "boolean" || typeof comparison.meaningCoverage === "number") {
			v.comparison = {
				categoryMatch: Boolean(comparison.categoryMatch),
				subcategoryMatch: Boolean(comparison.subcategoryMatch),
				meaningCoverage: typeof comparison.meaningCoverage === "number" ? comparison.meaningCoverage : 0,
				inventedMeaningCount: comparison.inventedMeaningCount ?? 0,
				lostMeaningCount: comparison.lostMeaningCount ?? 0,
				coherent: Boolean(comparison.coherent),
				problems: Array.isArray(comparison.problems) ? comparison.problems : [],
			};
		}
	}
}

/* ---------------------------------------------------------------- events */

function applyEvent(event) {
	if (!event || typeof event.type !== "string") return;

	// Anything about a run that is not the visible run may only report status.
	const isCurrent = event.runId && event.runId === state.currentRunId;

	switch (event.type) {
		case "run_started": {
			state.runHashes.set(event.runId, event.promptHash);
			if (state.currentHash && event.promptHash !== state.currentHash) {
				// A run for an older prompt: never adopt it, never render it.
				setStatus(`Ignoring run ${event.runId.slice(0, 8)} — it belongs to an older prompt (${event.promptHash}).`, "stale");
				return;
			}
			state.currentRunId = event.runId;
			state.currentHash = event.promptHash;
			state.analysis = null;
			state.view = emptyView();
			clearLive();
			renderAll();
			el.retryGlobal.hidden = true;
			setStatus(`Run ${event.runId.slice(0, 8)} started · prompt ${event.promptHash}`, "active");
			return;
		}

		case "stage_started": {
			if (!isCurrent) return;
			const s = state.stages[event.stage];
			if (!s) return;
			s.state = "active";
			s.text = "";
			s.error = "";
			s.startedAt = performance.now();
			const block = stageBlock(event.stage);
			block.open = true;
			block.querySelector("[data-stage-live-text]").textContent = "";
			paintStage(event.stage);
			setStatus(`${STAGE_LABEL[event.stage]} running · prompt ${state.currentHash}`, "active");
			renderOverview();
			return;
		}

		case "stage_delta": {
			if (!isCurrent) return;
			const s = state.stages[event.stage];
			if (!s) return;
			s.text += event.text ?? "";
			const block = stageBlock(event.stage);
			const pre = block.querySelector("[data-stage-live-text]");
			pre.textContent = s.text;
			pre.scrollTop = pre.scrollHeight;
			return;
		}

		case "stage_completed": {
			if (!isCurrent) return;
			const s = state.stages[event.stage];
			if (!s) return;
			s.state = "completed";
			s.ms = Math.round(performance.now() - (s.startedAt || performance.now()));
			const block = stageBlock(event.stage);
			block.open = false; // collapse the transcript once the structured result exists
			paintStage(event.stage);
			applyStageResult(event.stage, event.result);
			renderAll();
			setStatus(`${STAGE_LABEL[event.stage]} completed in ${s.ms} ms · prompt ${state.currentHash}`, "active");
			return;
		}

		case "stage_failed": {
			if (!isCurrent) return;
			const s = state.stages[event.stage];
			if (!s) return;
			s.state = "failed";
			s.error = event.error ?? "unknown error";
			const block = stageBlock(event.stage);
			block.open = true;
			paintStage(event.stage);
			el.retryGlobal.hidden = false;
			setStatus(`${STAGE_LABEL[event.stage]} failed — ${s.error}`, "error");
			renderOverview();
			return;
		}

		case "run_verified": {
			if (!isCurrent) return;
			const result = event.result;
			state.analysis = result;
			state.view = {
				paraphrase: result.paraphrase ?? "",
				parts: (result.parts ?? []).map(p => ({
					source: p.source ?? "",
					paraphrase: p.paraphrase ?? "",
					categories: p.categories ?? [],
					subcategories: p.subcategories ?? [],
					tags: p.tags ?? [],
				})),
				intent: (result.intent ?? []).map(a => ({ id: a.id ?? "", answer: a.answer ?? "", source: a.source ?? "" })),
				comparison: result.comparison ?? null,
				categories: categoriesOf(result.parts ?? []),
				tags: tagsOf(result.parts ?? []),
			};
			renderAll();
			el.retryGlobal.hidden = true;
			setStatus(`Verified · prompt ${result.promptHash ?? state.currentHash} · ${state.view.parts.length} parts, ${state.view.intent.length} intent answers`, "ok");
			return;
		}

		case "run_stale": {
			const hash = state.runHashes.get(event.runId) ?? "unknown";
			if (isCurrent) {
				markStagesStale();
				state.currentRunId = null;
				renderOverview();
			}
			const text = `Run ${event.runId.slice(0, 8)} (prompt ${hash}) was superseded by a newer prompt. Its results were discarded.`;
			noteRun("superseded", text);
			setStatus(text, "stale");
			return;
		}

		case "run_cancelled": {
			const hash = state.runHashes.get(event.runId) ?? "unknown";
			if (isCurrent) {
				markStagesStale();
				state.currentRunId = null;
				renderOverview();
			}
			const text = `Run ${event.runId.slice(0, 8)} (prompt ${hash}) was cancelled. Its results were discarded.`;
			noteRun("cancelled", text);
			setStatus(text, "stale");
			return;
		}

		default:
			return;
	}
}

/* ------------------------------------------------------------- transport */

function socketUrl() {
	const override = new URLSearchParams(location.search).get("ws");
	if (override) return override;
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${location.host}/ws`;
}

function connect() {
	if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
		return state.socket;
	}
	const socket = new WebSocket(socketUrl());
	state.socket = socket;
	setConnection("idle", "connecting…");

	socket.addEventListener("open", () => {
		state.connected = true;
		setConnection("live", "connected");
		if (socket.__queued) {
			const queued = socket.__queued;
			socket.__queued = null;
			socket.send(queued);
		}
	});
	socket.addEventListener("close", () => {
		state.connected = false;
		setConnection("down", "disconnected");
	});
	socket.addEventListener("error", () => {
		setConnection("down", "connection error");
	});
	socket.addEventListener("message", message => {
		let event;
		try {
			event = JSON.parse(message.data);
		} catch {
			return;
		}
		applyEvent(event);
	});
	return socket;
}

function send(payload) {
	const socket = connect();
	const body = JSON.stringify(payload);
	if (socket.readyState === WebSocket.OPEN) socket.send(body);
	else socket.__queued = body; // flushed on open; no timer, no polling
}

/* ------------------------------------------------- local activation rules */

function balanced(text) {
	let round = 0;
	let square = 0;
	let curly = 0;
	let double = 0;
	let backtick = 0;
	for (const ch of text) {
		if (ch === "(") round++;
		else if (ch === ")") round--;
		else if (ch === "[") square++;
		else if (ch === "]") square--;
		else if (ch === "{") curly++;
		else if (ch === "}") curly--;
		else if (ch === '"') double++;
		else if (ch === "`") backtick++;
	}
	return round <= 0 && square <= 0 && curly <= 0 && double % 2 === 0 && backtick % 2 === 0;
}

/** Local syntax check: is this text a complete clause worth analyzing? */
function isComplete(text) {
	const trimmed = text.trim();
	if (trimmed.length < MIN_AUTO_CHARS) return false;
	if (!balanced(trimmed)) return false;
	if (/[a-z0-9]-$/i.test(trimmed)) return false; // trailing hyphen: mid-word
	if (text.includes("\n")) return true; // a line was finished, not just typed into
	return /[.!?…:;][)"'`\]]?$/.test(trimmed);
}

let previouslyComplete = false;

async function requestAnalysis(reason, { force = false } = {}) {
	const rawPrompt = el.prompt.value;
	if (!rawPrompt.trim()) {
		setStatus("Idle — waiting for a prompt.");
		return;
	}
	if (!force && rawPrompt === state.lastSentPrompt) return;

	state.lastSentPrompt = rawPrompt;
	state.lastTrigger = reason;
	state.pendingPrompt = rawPrompt;
	const hash = await sha256Hex12(rawPrompt);

	// Newest hash wins: anything still running belongs to an older prompt.
	if (state.currentRunId) {
		send({ type: "cancel", runId: state.currentRunId });
		markStagesStale();
	}
	state.currentHash = hash;
	state.currentRunId = null;
	setStatus(`Analyzing prompt ${hash} (${reason})…`, "active");
	send({ type: "analyze", rawPrompt });
}

function retry(reason) {
	requestAnalysis(reason, { force: true });
}

el.prompt.addEventListener("input", event => {
	const value = el.prompt.value;
	const nowComplete = isComplete(value);

	// 1. substantial paste
	if (event.inputType === "insertFromPaste" && norm(event.data ?? value).length >= PASTE_TRIGGER_CHARS) {
		previouslyComplete = nowComplete;
		requestAnalysis("paste");
		return;
	}
	// 2. newline entered
	if (event.inputType === "insertLineBreak" || (event.data && event.data.includes("\n"))) {
		previouslyComplete = nowComplete;
		if (value.trim()) requestAnalysis("newline");
		return;
	}
	// 3. a sentence completed and whitespace followed
	if (/[.!?…][)"'`\]]?\s$/.test(value) && value.trim().length >= MIN_AUTO_CHARS) {
		previouslyComplete = nowComplete;
		requestAnalysis("sentence-end");
		return;
	}
	// 4. an incomplete clause just became complete
	if (!previouslyComplete && nowComplete) {
		previouslyComplete = true;
		requestAnalysis("clause-complete");
		return;
	}
	previouslyComplete = nowComplete;
});

el.prompt.addEventListener("blur", () => {
	if (el.prompt.value.trim()) requestAnalysis("blur");
});

el.prompt.addEventListener("keydown", event => {
	if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
		event.preventDefault();
		requestAnalysis("shortcut", { force: true });
	}
});

el.analyze.addEventListener("click", () => requestAnalysis("button", { force: true }));
el.retryGlobal.addEventListener("click", () => retry("global-retry"));

/* --------------------------------------------------------- raw json tools */

function rawJsonText() {
	return state.analysis ? JSON.stringify(state.analysis, null, 2) : "";
}

function rawStatus(text) {
	if (el.rawStatus) el.rawStatus.textContent = text;
}

el.rawCopy.addEventListener("click", async () => {
	const text = rawJsonText();
	if (!text) return;
	try {
		await navigator.clipboard.writeText(text);
		rawStatus("Copied to clipboard.");
	} catch {
		const scratch = document.createElement("textarea");
		scratch.value = text;
		scratch.setAttribute("readonly", "");
		scratch.style.position = "fixed";
		scratch.style.opacity = "0";
		document.body.appendChild(scratch);
		scratch.select();
		const ok = document.execCommand("copy");
		scratch.remove();
		rawStatus(ok ? "Copied to clipboard." : "Copy failed — select the text manually.");
	}
});

el.rawDownload.addEventListener("click", () => {
	const text = rawJsonText();
	if (!text) return;
	const hash = state.analysis?.promptHash ?? state.currentHash ?? "analysis";
	const blob = new Blob([text], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `prompt-analysis-${hash}.json`;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
	rawStatus(`Downloaded prompt-analysis-${hash}.json`);
});

/* ------------------------------------------------------------------ boot */

const modelFromQuery = new URLSearchParams(location.search).get("model");
el.modelBadge.textContent = `model: ${modelFromQuery ?? "server default"}`;

selectTab("overview");
renderAll();
connect();

// Test seam: deterministic event injection without a live socket.
window.__analyzer = { state, applyEvent, selectTab, isComplete, requestAnalysis };
