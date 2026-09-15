import * as path from "node:path";
import type { StorageMode } from "../contracts";
import { checksumJobJson } from "../jobs/checksum";
import { durableIo, type DurableIo, writeJsonAtomicDurable } from "../jobs/durable-fs";

export const EXPERIMENTAL_MODE_SWITCH_CAPABILITY = Object.freeze({
	state: "disabled" as const,
	reason: "WCDB native correctness, recovery, and archive accounting gates have not passed; real config commit is prohibited",
	configCommitAllowed: false as const,
});

export type ModeTransitionPhase =
	| "prepared"
	| "draining"
	| "transferring"
	| "verifying"
	| "commit-blocked"
	| "committing"
	| "reopening"
	| "completed"
	| "failed";

export interface GenerationToken {
	profileId: string;
	fromGeneration: number;
	toGeneration: number;
	nonce: string;
	checksum: string;
}

export interface ModeTransitionState {
	schemaVersion: 1;
	transitionId: string;
	profileId: string;
	previousMode: StorageMode;
	targetMode: StorageMode;
	activeMode: StorageMode;
	phase: ModeTransitionPhase;
	token: GenerationToken;
	completedSteps: readonly ModeTransitionPhase[];
	recoverableJobId: string | null;
	error: string | null;
	updatedAt: string;
	stateChecksum: string;
}

export interface ModeTransitionHooks {
	prepare(token: GenerationToken): Promise<{ allProcessesAcknowledgedOrStopped: boolean }>;
	drain(token: GenerationToken): Promise<void>;
	transfer(token: GenerationToken, recoverableJobId: string): Promise<{ recoverableJobId: string | null }>;
	verify(token: GenerationToken, targetMode: StorageMode): Promise<void>;
	reopen(mode: StorageMode, token: GenerationToken): Promise<void>;
}

/** Fault-injection and process-supervisor signal: leave the durable phase resumable instead of marking failure. */
export class ModeTransitionInterruptedError extends Error {
	constructor(message = "Mode transition interrupted") {
		super(message);
		this.name = "ModeTransitionInterruptedError";
	}
}

function tokenBody(token: Omit<GenerationToken, "checksum">) {
	return {
		profileId: token.profileId,
		fromGeneration: token.fromGeneration,
		toGeneration: token.toGeneration,
		nonce: token.nonce,
	};
}

function stateBody(state: Omit<ModeTransitionState, "stateChecksum">) {
	return {
		schemaVersion: state.schemaVersion,
		transitionId: state.transitionId,
		profileId: state.profileId,
		previousMode: state.previousMode,
		targetMode: state.targetMode,
		activeMode: state.activeMode,
		phase: state.phase,
		token: state.token,
		completedSteps: state.completedSteps,
		recoverableJobId: state.recoverableJobId,
		error: state.error,
		updatedAt: state.updatedAt,
	};
}

function validateState(input: unknown): ModeTransitionState {
	if (!input || typeof input !== "object") throw new Error("Mode transition state is not an object");
	const state = input as Partial<ModeTransitionState>;
	if (
		state.schemaVersion !== 1 ||
		typeof state.transitionId !== "string" ||
		typeof state.profileId !== "string" ||
		(state.previousMode !== "jsonl" && state.previousMode !== "db") ||
		(state.targetMode !== "jsonl" && state.targetMode !== "db") ||
		(state.activeMode !== "jsonl" && state.activeMode !== "db") ||
		typeof state.phase !== "string" ||
		!state.token ||
		typeof state.stateChecksum !== "string"
	) {
		throw new Error("Mode transition state has an invalid shape");
	}
	const complete = state as ModeTransitionState;
	if (complete.token.checksum !== checksumJobJson(tokenBody(complete.token))) {
		throw new Error("Mode transition generation token checksum mismatch");
	}
	if (complete.stateChecksum !== checksumJobJson(stateBody(complete))) {
		throw new Error("Mode transition state checksum mismatch");
	}
	return complete;
}

export function assertWriteFence(options: {
	processGeneration: number;
	activeGeneration: number;
	transition?: GenerationToken | null;
}): void {
	if (options.processGeneration !== options.activeGeneration) {
		throw new Error(
			`Stale storage writer generation ${options.processGeneration}; active generation is ${options.activeGeneration}`,
		);
	}
	if (options.transition && options.processGeneration === options.transition.fromGeneration) {
		throw new Error(`Storage transition to generation ${options.transition.toGeneration} is draining writers`);
	}
}

export class ExperimentalModeTransition {
	readonly #statePath: string;
	readonly #io: DurableIo;
	#state: ModeTransitionState;

	private constructor(statePath: string, state: ModeTransitionState, io: DurableIo) {
		this.#statePath = statePath;
		this.#state = state;
		this.#io = io;
	}

	static async create(options: {
		directory: string;
		transitionId: string;
		profileId: string;
		activeMode: StorageMode;
		activeGeneration: number;
		targetMode: StorageMode;
		io?: DurableIo;
		now?: () => string;
	}): Promise<ExperimentalModeTransition> {
		if (options.activeMode === options.targetMode) throw new Error("Mode transition target is already active");
		if (!Number.isSafeInteger(options.activeGeneration) || options.activeGeneration < 0) {
			throw new Error("Active configuration generation must be a non-negative safe integer");
		}
		const io = options.io ?? durableIo;
		const tokenWithoutChecksum = {
			profileId: options.profileId,
			fromGeneration: options.activeGeneration,
			toGeneration: options.activeGeneration + 1,
			nonce: crypto.randomUUID(),
		};
		const token: GenerationToken = {
			...tokenWithoutChecksum,
			checksum: checksumJobJson(tokenBody(tokenWithoutChecksum)),
		};
		const body = {
			schemaVersion: 1 as const,
			transitionId: options.transitionId,
			profileId: options.profileId,
			previousMode: options.activeMode,
			targetMode: options.targetMode,
			activeMode: options.activeMode,
			phase: "prepared" as const,
			token,
			completedSteps: [] as readonly ModeTransitionPhase[],
			recoverableJobId: null,
			error: null,
			updatedAt: (options.now ?? (() => new Date().toISOString()))(),
		};
		const state: ModeTransitionState = { ...body, stateChecksum: checksumJobJson(stateBody(body)) };
		const statePath = path.join(options.directory, "transition.json");
		await writeJsonAtomicDurable(statePath, state, io);
		return new ExperimentalModeTransition(statePath, state, io);
	}

	static async open(directory: string, io: DurableIo = durableIo): Promise<ExperimentalModeTransition> {
		const statePath = path.join(directory, "transition.json");
		const state = validateState(JSON.parse(await io.readText(statePath)) as unknown);
		return new ExperimentalModeTransition(statePath, state, io);
	}

	get state(): ModeTransitionState {
		return structuredClone(this.#state);
	}

	async execute(hooks: ModeTransitionHooks, now: () => string = () => new Date().toISOString()): Promise<ModeTransitionState> {
		if (this.#state.phase === "completed" || this.#state.phase === "failed") return this.state;
		try {
			while (true) {
				switch (this.#state.phase) {
					case "prepared": {
						const prepared = await hooks.prepare(this.#state.token);
						if (!prepared.allProcessesAcknowledgedOrStopped) {
							throw new Error("Not every running process acknowledged the storage generation fence or stopped");
						}
						await this.#advance("draining", now());
						break;
					}
					case "draining":
						await hooks.drain(this.#state.token);
						await this.#advance("transferring", now());
						break;
					case "transferring": {
						const recoverableJobId =
							this.#state.recoverableJobId ??
							`mode-transition-${checksumJobJson({
								profileId: this.#state.profileId,
								transitionId: this.#state.transitionId,
								generation: this.#state.token.toGeneration,
							})}`;
						if (this.#state.recoverableJobId === null) {
							await this.#update({ recoverableJobId }, now());
						}
						const transfer = await hooks.transfer(this.#state.token, recoverableJobId);
						if (transfer.recoverableJobId !== null && transfer.recoverableJobId !== recoverableJobId) {
							throw new Error(`Transfer returned unexpected recoverable job ${transfer.recoverableJobId}`);
						}
						await this.#advance("verifying", now());
						break;
					}
					case "verifying":
						await hooks.verify(this.#state.token, this.#state.targetMode);
						await this.#advance("commit-blocked", now());
						break;
					case "commit-blocked":
					case "committing":
					case "reopening":
						throw new Error(EXPERIMENTAL_MODE_SWITCH_CAPABILITY.reason);
					case "completed":
					case "failed":
						return this.state;
				}
			}
		} catch (error) {
			if (error instanceof ModeTransitionInterruptedError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			await this.#update({ phase: "failed", activeMode: this.#state.previousMode, error: message }, now());
			return this.state;
		}
	}

	async #advance(phase: ModeTransitionPhase, timestamp: string): Promise<void> {
		await this.#update(
			{
				phase,
				completedSteps: [...this.#state.completedSteps, this.#state.phase],
			},
			timestamp,
		);
	}

	async #update(changes: Partial<Omit<ModeTransitionState, "stateChecksum">>, timestamp: string): Promise<void> {
		const body = { ...stateBody(this.#state), ...changes, updatedAt: timestamp };
		const next: ModeTransitionState = { ...body, stateChecksum: checksumJobJson(stateBody(body)) };
		await writeJsonAtomicDurable(this.#statePath, next, this.#io);
		this.#state = next;
	}
}
