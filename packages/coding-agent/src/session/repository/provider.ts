import { JsonlSessionRepository } from "./jsonl-repository";
import type { JsonlSessionRepositoryOptions } from "./jsonl-repository";
import type { SessionRepository } from "./types";
import type { TursoRuntimeAdapter, TursoSessionRepositoryOptions } from "./turso/repository";

export interface JsonlRepositoryProviderOptions extends JsonlSessionRepositoryOptions {
	mode: "jsonl";
}

type TursoRepositoryTuning = Omit<TursoSessionRepositoryOptions, "adapter">;

type TursoAdapterSource =
	| { adapter: TursoRuntimeAdapter; loadAdapter?: never }
	| { adapter?: never; loadAdapter: () => Promise<TursoRuntimeAdapter> };

export type DatabaseRepositoryProviderOptions = { mode: "db" } & TursoRepositoryTuning & TursoAdapterSource;
export type SessionRepositoryProviderOptions = JsonlRepositoryProviderOptions | DatabaseRepositoryProviderOptions;

/**
 * Explicit runtime-mode seam. The JSONL branch neither imports the Turso
 * repository module nor invokes an engine loader. DB activation must supply an
 * already-validated adapter, directly or through its lazy loader.
 */
export async function createSessionRepository(options: SessionRepositoryProviderOptions): Promise<SessionRepository> {
	if (options.mode === "jsonl") {
		return new JsonlSessionRepository({
			rootDir: options.rootDir,
			replicaId: options.replicaId,
			modeGeneration: options.modeGeneration,
			sourceNamespace: options.sourceNamespace,
			installationNamespace: options.installationNamespace,
		});
	}

	const adapter = options.adapter ?? (await options.loadAdapter());
	const repositoryModule = await import("./turso/repository");
	return repositoryModule.createTursoSessionRepository({
		adapter,
		maxQueuedBytes: options.maxQueuedBytes,
		maxPageSize: options.maxPageSize,
		defaultPageSize: options.defaultPageSize,
		payloadChunkBytes: options.payloadChunkBytes,
		maxPayloadChunkBytes: options.maxPayloadChunkBytes,
		maxPinnedResults: options.maxPinnedResults,
	});
}
