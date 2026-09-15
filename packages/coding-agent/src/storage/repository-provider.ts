import type { BranchId, SessionRepository, StorageMode } from "./contracts";
import { parseBranchId } from "./identity";

export type SessionRepositoryFactory = () => Promise<SessionRepository>;

export interface SessionRepositoryFactories {
	readonly jsonl: SessionRepositoryFactory;
	/** Omitted until the native/schema capability gates pass. */
	readonly db?: SessionRepositoryFactory;
}

export class RepositoryModeUnavailableError extends Error {
	readonly mode: StorageMode;

	constructor(mode: StorageMode) {
		super(
			mode === "db"
				? "Database storage is capability-disabled on this installation; use JSONL mode until the WCDB gate passes."
				: "JSONL storage is unavailable on this installation.",
		);
		this.name = "RepositoryModeUnavailableError";
		this.mode = mode;
	}
}

/**
 * Explicit storage-mode boundary. Factories are injected, so importing or
 * selecting JSONL never imports the WCDB worker/native module graph.
 */
export class SessionRepositoryProvider {
	readonly #factories: SessionRepositoryFactories;
	#active: SessionRepository | undefined;
	#opening: Promise<SessionRepository> | undefined;

	constructor(factories: SessionRepositoryFactories) {
		this.#factories = factories;
	}

	get active(): SessionRepository | undefined {
		return this.#active;
	}

	async open(mode: StorageMode): Promise<SessionRepository> {
		if (this.#active?.mode === mode) return this.#active;
		if (this.#opening) {
			const opening = await this.#opening;
			if (opening.mode === mode) return opening;
		}
		const factory = this.#factories[mode];
		if (!factory) throw new RepositoryModeUnavailableError(mode);
		const opening = factory().then(repository => {
			if (repository.mode !== mode) {
				void repository.close();
				throw new Error(`Repository factory for ${mode} returned ${repository.mode}`);
			}
			return repository;
		});
		this.#opening = opening;
		try {
			const repository = await opening;
			const previous = this.#active;
			this.#active = repository;
			if (previous && previous !== repository) await previous.close();
			return repository;
		} finally {
			if (this.#opening === opening) this.#opening = undefined;
		}
	}
	async close(): Promise<void> {
		const repository = this.#active;
		this.#active = undefined;
		if (repository) await repository.close();
	}
}


const DB_SESSION_PREFIX = "omp-db-session://";
let configuredProvider: SessionRepositoryProvider | undefined;

export function installSessionRepositoryProvider(provider: SessionRepositoryProvider | undefined): void {
	configuredProvider = provider;
}

export function activeSessionRepository(): SessionRepository | undefined {
	return configuredProvider?.active;
}

export function repositorySessionRef(branchId: BranchId): string {
	return `${DB_SESSION_PREFIX}${encodeURIComponent(branchId)}`;
}

export function parseRepositorySessionRef(value: string): BranchId | undefined {
	if (!value.startsWith(DB_SESSION_PREFIX)) return undefined;
	return parseBranchId(decodeURIComponent(value.slice(DB_SESSION_PREFIX.length)));
}

export function requireJsonlSessionPath(value: string): string {
	if (parseRepositorySessionRef(value)) {
		throw new Error(
			"Database sessions do not have JSONL paths. Export the branch explicitly or switch storage mode to JSONL.",
		);
	}
	return value;
}
