import type { AgentType } from "./shared-types";
import {
	parseRepositoryEventPage,
	type RepositoryStatsBatch,
	type RepositoryStatsIdentity,
} from "./parser";
import type { SessionEntry } from "./types";

interface RepositoryHeaderView {
	originId: string;
	branchId: string;
	versionId: string;
	metadata: { cwd?: string; extensions?: Readonly<Record<string, unknown>> };
}


/**
 * Structural subset of SessionRepository used by the standalone stats package.
 * SessionRepository is assignable to this type without coupling stats to the
 * coding-agent package at runtime.
 */
export interface RepositoryStatsSource<Cursor, Branch extends string, Version extends string> {
	readonly mode: "jsonl" | "db";
	listSessions(query?: {
		cursor?: Cursor;
		limit?: number;
	}): Promise<{
		items: readonly (Omit<RepositoryHeaderView, "branchId" | "versionId"> & {
			branchId: Branch;
			versionId: Version;
		})[];
		nextCursor?: Cursor;
	}>;
	readEvents(query: {
		branchId: Branch;
		versionId?: Version;
		cursor?: Cursor;
		limit?: number;
	}): Promise<{ items: readonly { entry: SessionEntry }[]; nextCursor?: Cursor }>;
}

export interface StreamRepositoryStatsOptions {
	sessionPageSize?: number;
	eventPageSize?: number;
	maxSessions?: number;
}

export interface RepositoryStatsPage {
	identity: RepositoryStatsIdentity;
	batch: RepositoryStatsBatch;
}

/**
 * Stream stats directly from repository keyset pages. The generator yields one
 * bounded event page at a time and never opens stats.db or session JSONL.
 */
export async function* streamRepositoryStats<Cursor, Branch extends string, Version extends string>(
	repository: RepositoryStatsSource<Cursor, Branch, Version>,
	options: StreamRepositoryStatsOptions = {},
): AsyncGenerator<RepositoryStatsPage> {
	const sessionPageSize = normalizePageSize(options.sessionPageSize);
	const eventPageSize = normalizePageSize(options.eventPageSize);
	const maxSessions = normalizeMaxSessions(options.maxSessions);
	let sessionCursor: Cursor | undefined;
	let visited = 0;
	do {
		const sessions = await repository.listSessions({ cursor: sessionCursor, limit: sessionPageSize });
		for (const header of sessions.items) {
			if (visited >= maxSessions) return;
			visited += 1;
			const identity: RepositoryStatsIdentity = {
				originId: header.originId,
				branchId: header.branchId,
				versionId: header.versionId,
				cwd: header.metadata.cwd,
				agentType: repositoryAgentType(header),
			};
			let eventCursor: Cursor | undefined;
			let currentServiceTier: RepositoryStatsBatch["currentServiceTier"];
			do {
				const events = await repository.readEvents({
					branchId: header.branchId,
					versionId: header.versionId,
					cursor: eventCursor,
					limit: eventPageSize,
				});
				const entries = events.items.map(event => event.entry);
				const batch = parseRepositoryEventPage(entries, identity, currentServiceTier);
				currentServiceTier = batch.currentServiceTier;
				yield { identity, batch };
				eventCursor = events.nextCursor;
			} while (eventCursor);
		}
		sessionCursor = sessions.nextCursor;
	} while (sessionCursor && visited < maxSessions);
}

function normalizePageSize(value: number | undefined): number {
	return Math.max(1, Math.min(500, Math.floor(value ?? 100)));
}

function normalizeMaxSessions(value: number | undefined): number {
	if (value === undefined) return Number.MAX_SAFE_INTEGER;
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function repositoryAgentType(header: RepositoryHeaderView): AgentType {
	const value = header.metadata.extensions?.["omp.agentType"];
	return value === "subagent" || value === "advisor" ? value : "main";
}
