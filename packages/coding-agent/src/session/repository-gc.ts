import type { ModeGeneration, SessionLocator, SessionRepository } from "./repository/types";

export interface RepositoryGcRequest {
	repository: SessionRepository;
	expectedModeGeneration: ModeGeneration;
	/** Exact logical sessions selected by the user. Absence is never a deletion signal. */
	drop: readonly SessionLocator[];
}

export interface RepositoryGcResult {
	requested: number;
	dropped: number;
}

/** Apply only explicit logical drop intents. This path performs no JSONL discovery. */
export async function runRepositoryGc(request: RepositoryGcRequest): Promise<RepositoryGcResult> {
	let dropped = 0;
	for (const locator of request.drop) {
		if (
			await request.repository.drop({
				locator,
				explicit: true,
				expectedModeGeneration: request.expectedModeGeneration,
			})
		) {
			dropped++;
		}
	}
	return { requested: request.drop.length, dropped };
}
