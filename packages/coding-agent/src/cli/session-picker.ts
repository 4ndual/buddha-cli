import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { SessionSelectorComponent } from "../modes/components/session-selector";
import { HistoryStorage } from "../session/history-storage";
import {
	listRepositorySessionsPage,
	type LogicalSessionInfo,
	type SessionInfo,
} from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { loadPinnedSessionIds } from "../session/session-pins";
import { FileSessionStorage } from "../session/session-storage";
import type { ListSessionsQuery, SessionRepository } from "../session/repository/types";

type SelectableSession = SessionInfo | LogicalSessionInfo;

/** Presentation and capability controls for the standalone session picker. */
export interface SessionPickerOptions {
	allSessions?: SelectableSession[];
	title?: string;
	scopeLabel?: string | false;
	showCwd?: boolean;
	allowDelete?: boolean;
	allowGlobalScope?: boolean;
	historySearch?: boolean;
	pinnedIds?: ReadonlySet<string>;
	repository?: SessionRepository;
}

/**
 * Show the TUI session selector and return the selected session, or null if
 * cancelled. The default OMP picker supports deletion, transcript-history
 * search, and an all-projects scope; foreign import pickers disable those
 * source-owned capabilities.
 */
export async function selectSession<T extends SelectableSession>(
	sessions: T[],
	options: SessionPickerOptions = {},
): Promise<T | null> {
	const { promise, resolve } = Promise.withResolvers<T | null>();
	const ui = new TUI(new ProcessTerminal());
	let resolved = false;
	const storage = new FileSessionStorage();

	// Rank sessions with prompt-history matches too, recovering prompts the 4KB
	// session-list prefix never sees. Best-effort: a missing/locked history.db
	// must not break the picker.
	const pinnedIds = options.pinnedIds ?? (await loadPinnedSessionIds());

	let historyMatcher: ((query: string) => string[]) | undefined;
	if (options.historySearch !== false && !options.repository) {
		try {
			const history = HistoryStorage.open();
			historyMatcher = (query: string) => history.matchingSessionIds(query);
		} catch (error) {
			logger.warn("History storage unavailable for session ranking", { error: String(error) });
		}
	}

	const showSelector = () => {
		const selector = new SessionSelectorComponent(
			sessions,
			(session: SelectableSession) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(session as T);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					process.exit(0);
				}
			},
			{
				onDelete:
					options.allowDelete === false
						? undefined
						: async (session: SelectableSession) => {
								if (session.locator && options.repository) {
									const health = await options.repository.health();
									return options.repository.drop({
										locator: session.locator,
										explicit: true,
										expectedModeGeneration: health.modeGeneration,
									});
								}
								if (!session.path) throw new Error("Session has no deletable JSONL path");
								await storage.deleteSessionWithArtifacts(session.path);
								return true;
							},
				historyMatcher,
				loadAllSessions:
					options.allowGlobalScope === false
						? undefined
						: options.repository
							? async () => [...(await listRepositorySessionsPage(options.repository!, { limit: 100 })).items]
							: () => SessionManager.listAll(storage),
				allSessions: options.allSessions,
				getTerminalRows: () => ui.terminal.rows,
				fillHeight: true,
				title: options.title,
				scopeLabel: options.scopeLabel,
				showCwd: options.showCwd,
				pinnedIds,
			},
		);
		return selector;
	};

	const selector = showSelector();
	selector.setOnRequestRender(() => ui.requestRender());
	// Present as a fullscreen overlay so the picker borrows the terminal's
	// alternate screen buffer (vim/less idiom): the list scrolls and rows are
	// clickable via the mouse tracking the overlay enables for its lifetime.
	// Anchored top-left at full size so a mouse row maps directly to a rendered
	// line (the overlay paints from screen row 0).
	ui.showOverlay(selector, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
	});
	ui.setFocus(selector);
	ui.start();
	return promise;
}

/** Open a picker over one bounded repository page. */
export async function selectRepositorySession(
	repository: SessionRepository,
	query: ListSessionsQuery = {},
	options: Omit<SessionPickerOptions, "repository"> = {},
): Promise<LogicalSessionInfo | null> {
	const page = await listRepositorySessionsPage(repository, { ...query, limit: query.limit ?? 100 });
	const selected = await selectSession([...page.items], { ...options, repository, historySearch: false });
	return (selected as LogicalSessionInfo | null) ?? null;
}
