import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, type JsonValue } from "./bundle";

export const FENCE_STATE_FORMAT = "omp-storage-fence-v1";

export type StorageMode = "jsonl" | "db";
export type FencedWriteOperation = "append" | "fork" | "checkpoint" | "flush";
export type TransitionState = "stable" | "preparing" | "verified" | "aborted";

export interface GenerationToken {
	generation: number;
	nonce: string;
}

export interface FenceState {
	format: typeof FENCE_STATE_FORMAT;
	active_mode: StorageMode;
	generation: number;
	nonce: string;
	state: TransitionState;
	transition_id: string | null;
	target_mode: StorageMode | null;
	verification_receipt: string | null;
}

export interface PreparedTransition {
	transitionId: string;
	fromMode: StorageMode;
	targetMode: StorageMode;
	token: GenerationToken;
	verificationReceipt: string;
}

export interface TransitionSteps {
	prepare(token: GenerationToken): Promise<void>;
	drain(token: GenerationToken): Promise<void>;
	synchronize(token: GenerationToken): Promise<void>;
	verify(token: GenerationToken): Promise<string>;
}

export async function createGenerationFence(path: string, activeMode: StorageMode): Promise<GenerationToken> {
	const absolute = resolve(path);
	await mkdir(dirname(absolute), { recursive: true });
	await assertNoSymlinkComponents(dirname(absolute), absolute, true);
	const state: FenceState = {
		format: FENCE_STATE_FORMAT,
		active_mode: activeMode,
		generation: 1,
		nonce: randomBytes(16).toString("hex"),
		state: "stable",
		transition_id: null,
		target_mode: null,
		verification_receipt: null,
	};
	const handle = await open(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), 0o600);
	try {
		await handle.writeFile(`${canonicalJson(state as unknown as JsonValue)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fsyncDirectory(dirname(absolute));
	return tokenOf(state);
}

export async function readFenceState(path: string): Promise<FenceState> {
	const absolute = resolve(path);
	const handle = await open(absolute, constants.O_RDONLY | noFollowFlag());
	try {
		const state = JSON.parse(await handle.readFile("utf8")) as FenceState;
		assertFenceState(state);
		return state;
	} finally {
		await handle.close();
	}
}

/** Every append/fork/checkpoint/flush adapter calls this immediately before its durable commit. */
export async function assertGenerationToken(
	path: string,
	token: GenerationToken,
	_operation: FencedWriteOperation,
): Promise<FenceState> {
	const state = await readFenceState(path);
	if (state.generation !== token.generation || state.nonce !== token.nonce) {
		throw new Error(`Stale storage generation ${token.generation}; current generation is ${state.generation}`);
	}
	if (state.state === "aborted") throw new Error("Storage generation belongs to an aborted transition");
	return state;
}

/** Runs prepare → drain → synchronize → verify. It never writes the active production configuration. */
export async function prepareDrainVerifyTransition(
	fencePath: string,
	expectedToken: GenerationToken,
	targetMode: StorageMode,
	steps: TransitionSteps,
): Promise<PreparedTransition> {
	const begun = await beginTransition(fencePath, expectedToken, targetMode);
	const token = tokenOf(begun);
	try {
		await steps.prepare(token);
		await steps.drain(token);
		await steps.synchronize(token);
		const verificationReceipt = await steps.verify(token);
		if (!verificationReceipt) throw new Error("Transition verification returned no durable receipt");
		const verified = await mutateFence(fencePath, token, (state) => ({
			...state,
			state: "verified",
			verification_receipt: verificationReceipt,
		}));
		return {
			transitionId: verified.transition_id!,
			fromMode: verified.active_mode,
			targetMode,
			token,
			verificationReceipt,
		};
	} catch (error) {
		await mutateFence(fencePath, token, (state) => ({ ...state, state: "aborted" })).catch(() => undefined);
		throw error;
	}
}

export async function beginTransition(
	fencePath: string,
	expectedToken: GenerationToken,
	targetMode: StorageMode,
): Promise<FenceState> {
	return mutateFence(fencePath, expectedToken, (state) => {
		if (state.state !== "stable") throw new Error(`Cannot begin transition while fence is ${state.state}`);
		if (state.active_mode === targetMode) throw new Error(`Storage is already in ${targetMode} mode`);
		return {
			...state,
			generation: state.generation + 1,
			nonce: randomBytes(16).toString("hex"),
			state: "preparing",
			transition_id: randomBytes(16).toString("hex"),
			target_mode: targetMode,
			verification_receipt: null,
		};
	});
}

export function tokenOf(state: FenceState): GenerationToken {
	return { generation: state.generation, nonce: state.nonce };
}

/**
 * Rejects traversal and every symlink component. The caller then opens the leaf
 * with O_NOFOLLOW, retaining containment through the descriptor used for I/O.
 */
export async function assertNoSymlinkComponents(root: string, candidate: string, allowMissingLeaf = false): Promise<string> {
	const absoluteRoot = resolve(root);
	const absoluteCandidate = resolve(candidate);
	const rel = relative(absoluteRoot, absoluteCandidate);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes its allowed root");
	const rootStat = await lstat(absoluteRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Allowed root must be a real directory");
	if ((await realpath(absoluteRoot)) !== absoluteRoot) throw new Error("Allowed root resolves through a symlink");
	let cursor = absoluteRoot;
	const parts = rel ? rel.split(sep) : [];
	for (let index = 0; index < parts.length; index += 1) {
		cursor = resolve(cursor, parts[index]);
		try {
			const stat = await lstat(cursor);
			if (stat.isSymbolicLink()) throw new Error(`Symlink path component is forbidden: ${cursor}`);
			if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Non-directory path component: ${cursor}`);
		} catch (error) {
			if (allowMissingLeaf && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") break;
			throw error;
		}
	}
	return absoluteCandidate;
}

async function mutateFence(
	path: string,
	expected: GenerationToken,
	mutate: (state: FenceState) => FenceState,
): Promise<FenceState> {
	const absolute = resolve(path);
	const lockPath = `${absolute}.lock`;
	const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), 0o600).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "EEXIST") throw new Error("Storage transition fence is locked");
			throw error;
		},
	);
	try {
		const current = await readFenceState(absolute);
		if (current.generation !== expected.generation || current.nonce !== expected.nonce) {
			throw new Error(`Stale storage generation ${expected.generation}; current generation is ${current.generation}`);
		}
		const next = mutate(current);
		assertFenceState(next);
		const temporary = `${absolute}.next-${next.generation}-${randomBytes(6).toString("hex")}`;
		await writeFile(temporary, `${canonicalJson(next as unknown as JsonValue)}\n`, {
			flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
			mode: 0o600,
		});
		const handle = await open(temporary, constants.O_RDONLY | noFollowFlag());
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, absolute);
		await fsyncDirectory(dirname(absolute));
		return next;
	} finally {
		await lock.close();
		await rm(lockPath, { force: true });
	}
}

function assertFenceState(state: FenceState): void {
	if (state.format !== FENCE_STATE_FORMAT) throw new Error("Unsupported generation fence format");
	if (!Number.isSafeInteger(state.generation) || state.generation < 1 || !state.nonce) throw new Error("Invalid generation fence");
	if (state.state === "stable" && (state.transition_id !== null || state.target_mode !== null)) {
		throw new Error("Stable fence unexpectedly contains a transition");
	}
}

function noFollowFlag(): number {
	return constants.O_NOFOLLOW ?? 0;
}

async function fsyncDirectory(path: string): Promise<void> {
	const directory = await open(path, constants.O_RDONLY | noFollowFlag());
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
