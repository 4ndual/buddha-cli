import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, open, realpath } from "node:fs/promises";
import * as path from "node:path";
import { migrateTursoSchema, TURSO_SCHEMA_VERSION, type SchemaStatementResult, verifyTursoSchemaVersion } from "./schema";

export const TURSO_DATABASE_PACKAGE_VERSION = "0.7.2";
export const TURSO_NATIVE_PACKAGE_VERSION = "0.7.2";
export const TURSO_VALIDATED_BUN_VERSION = "1.4.2";

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const REQUIRED_EXPERIMENTAL_FEATURES = ["index_method", "multiprocess_wal"] as const;

type QueryParameters = readonly unknown[];

export type TursoTransactionMode = "deferred" | "immediate" | "exclusive" | "concurrent";

export interface TursoPreparedStatement {
	run(...parameters: unknown[]): Promise<SchemaStatementResult>;
	get<T = Record<string, unknown>>(...parameters: unknown[]): Promise<T | undefined>;
	all<T = Record<string, unknown>>(...parameters: unknown[]): Promise<T[]>;
	iterate<T = Record<string, unknown>>(...parameters: unknown[]): AsyncGenerator<T, void, unknown>;
	interrupt(): void;
	safeIntegers(enabled: boolean): TursoPreparedStatement;
	close(): void;
}

export interface TursoTransaction {
	exec(sql: string, options?: { queryTimeout?: number }): Promise<void>;
	run(sql: string, ...parameters: unknown[]): Promise<SchemaStatementResult>;
	get<T = Record<string, unknown>>(sql: string, ...parameters: unknown[]): Promise<T | undefined>;
	all<T = Record<string, unknown>>(sql: string, ...parameters: unknown[]): Promise<T[]>;
	iterate<T = Record<string, unknown>>(sql: string, ...parameters: unknown[]): AsyncGenerator<T, void, unknown>;
	prepare(sql: string): Promise<TursoPreparedStatement>;
}

interface DriverDatabase {
	open: boolean;
	defaultSafeIntegers(enabled: boolean): void;
	exec(sql: string, options?: { queryTimeout?: number }): Promise<void>;
	run(sql: string, ...parameters: unknown[]): Promise<SchemaStatementResult>;
	get<T = Record<string, unknown>>(sql: string, ...parameters: unknown[]): Promise<T | undefined>;
	all<T = Record<string, unknown>>(sql: string, ...parameters: unknown[]): Promise<T[]>;
	iterate<T = Record<string, unknown>>(sql: string, ...parameters: unknown[]): AsyncGenerator<T, void, unknown>;
	prepare(sql: string): Promise<TursoPreparedStatement>;
	transactionAsync<T, A extends unknown[]>(
		operation: (transaction: TursoTransaction, ...args: A) => Promise<T>,
	): ((...args: A) => Promise<T>) & {
		deferred: (...args: A) => Promise<T>;
		immediate: (...args: A) => Promise<T>;
		exclusive: (...args: A) => Promise<T>;
		concurrent: (...args: A) => Promise<T>;
	};
	close(): Promise<void>;
}

export interface OpenLocalTursoDatabaseOptions {
	/** Absolute database filename. URI forms and in-memory databases are rejected. */
	path: string;
	/** Absolute directory the database must remain inside after resolving symlinks. */
	allowedRoot: string;
	readonly?: boolean;
	fileMustExist?: boolean;
	timeoutMs?: number;
	queryTimeoutMs?: number;
	/** Defaults to true for writable connections and is prohibited for read-only connections. */
	migrate?: boolean;
}

export interface TursoCheckpointResult {
	busy: number;
	logFrames: number;
	checkpointedFrames: number;
}

export interface TursoBackupReceipt {
	sourcePath: string;
	destinationPath: string;
	checkpoint: TursoCheckpointResult;
	closedBeforeCopy: true;
	copiedAt: number;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertPlainAbsolutePath(candidate: string, field: string): void {
	if (!candidate || candidate.includes("\0")) throw new Error(`${field} must be a non-empty filesystem path`);
	if (candidate === ":memory:" || URL_SCHEME.test(candidate) || candidate.startsWith("//")) {
		throw new Error(`${field} must be a local file path; URLs, cloud endpoints, sync targets, and memory databases are rejected`);
	}
	if (!path.isAbsolute(candidate)) throw new Error(`${field} must be absolute`);
}

async function resolveConfinedPath(candidate: string, allowedRoot: string, mustExist: boolean): Promise<string> {
	assertPlainAbsolutePath(candidate, "Database path");
	assertPlainAbsolutePath(allowedRoot, "Allowed database root");
	const canonicalRoot = await realpath(allowedRoot);
	const parent = await realpath(path.dirname(candidate));
	const resolvedCandidate = path.join(parent, path.basename(candidate));
	if (!isWithin(canonicalRoot, resolvedCandidate)) {
		throw new Error(`Database path escapes allowed root: ${candidate}`);
	}

	try {
		const status = await lstat(candidate);
		if (!status.isFile()) throw new Error(`Database path is not a regular file: ${candidate}`);
		const existing = await realpath(candidate);
		if (!isWithin(canonicalRoot, existing)) throw new Error(`Database path symlink escapes allowed root: ${candidate}`);
		return existing;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw error;
		if (mustExist) throw new Error(`Database file does not exist: ${candidate}`, { cause: error });
		return resolvedCandidate;
	}
}

function numericField(row: Record<string, unknown>, named: string, positional: string): number {
	const value = row[named] ?? row[positional];
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid ${named} value returned by Turso: ${String(value)}`);
	return number;
}

export class TursoDatabase {
	readonly path: string;
	readonly allowedRoot: string;
	readonly readonly: boolean;
	readonly schemaVersion: number;
	#driver: DriverDatabase | undefined;

	constructor(options: {
		path: string;
		allowedRoot: string;
		readonly: boolean;
		schemaVersion: number;
		driver: DriverDatabase;
	}) {
		this.path = options.path;
		this.allowedRoot = options.allowedRoot;
		this.readonly = options.readonly;
		this.schemaVersion = options.schemaVersion;
		this.#driver = options.driver;
	}

	get open(): boolean {
		return this.#driver?.open === true;
	}

	#connection(): DriverDatabase {
		if (!this.#driver?.open) throw new Error("Turso database is closed");
		return this.#driver;
	}

	exec(sql: string, options?: { queryTimeout?: number }): Promise<void> {
		return this.#connection().exec(sql, options);
	}

	run(sql: string, ...parameters: QueryParameters): Promise<SchemaStatementResult> {
		return this.#connection().run(sql, ...parameters);
	}

	get<T = Record<string, unknown>>(sql: string, ...parameters: QueryParameters): Promise<T | undefined> {
		return this.#connection().get<T>(sql, ...parameters);
	}

	all<T = Record<string, unknown>>(sql: string, ...parameters: QueryParameters): Promise<T[]> {
		return this.#connection().all<T>(sql, ...parameters);
	}

	iterate<T = Record<string, unknown>>(
		sql: string,
		...parameters: QueryParameters
	): AsyncGenerator<T, void, unknown> {
		return this.#connection().iterate<T>(sql, ...parameters);
	}

	prepare(sql: string): Promise<TursoPreparedStatement> {
		return this.#connection().prepare(sql);
	}

	async transactionAsync<T>(
		operation: (transaction: TursoTransaction) => Promise<T>,
		mode: TursoTransactionMode = "immediate",
	): Promise<T> {
		return this.#connection().transactionAsync(operation)[mode]();
	}

	async checkpoint(): Promise<TursoCheckpointResult> {
		const row = await this.get<Record<string, unknown>>("PRAGMA wal_checkpoint(FULL)");
		if (!row) throw new Error("Turso returned no checkpoint result");
		return {
			busy: numericField(row, "busy", "0"),
			logFrames: numericField(row, "log", "1"),
			checkpointedFrames: numericField(row, "checkpointed", "2"),
		};
	}

	async close(): Promise<void> {
		const driver = this.#driver;
		this.#driver = undefined;
		if (driver?.open) await driver.close();
	}

	/**
	 * The pinned native backup API is not implemented. This verified fallback drains the
	 * connection, checkpoints and closes it, then copies the complete main file and fsyncs
	 * both the copy and its parent directory. The connection remains closed.
	 */
	async closeAndBackup(destination: string, allowedBackupRoot: string): Promise<TursoBackupReceipt> {
		if (this.readonly) throw new Error("Cannot create a managed backup from a read-only connection");
		const resolvedDestination = await resolveConfinedPath(destination, allowedBackupRoot, false);
		if (resolvedDestination === this.path) throw new Error("Backup destination must differ from the source database");
		const checkpoint = await this.checkpoint();
		if (checkpoint.busy !== 0) throw new Error("Cannot back up Turso database while checkpoint reports busy readers or writers");
		await this.close();
		await copyFile(this.path, resolvedDestination, fsConstants.COPYFILE_EXCL);
		const destinationFile = await open(resolvedDestination, "r");
		try {
			await destinationFile.sync();
		} finally {
			await destinationFile.close();
		}
		const destinationDirectory = await open(path.dirname(resolvedDestination), "r");
		try {
			await destinationDirectory.sync();
		} finally {
			await destinationDirectory.close();
		}
		return {
			sourcePath: this.path,
			destinationPath: resolvedDestination,
			checkpoint,
			closedBeforeCopy: true,
			copiedAt: Date.now(),
		};
	}
}

export async function openLocalTursoDatabase(options: OpenLocalTursoDatabaseOptions): Promise<TursoDatabase> {
	if (options.readonly && options.migrate === true) throw new Error("Cannot migrate a read-only Turso database");
	const databasePath = await resolveConfinedPath(options.path, options.allowedRoot, options.fileMustExist === true);
	const databaseModule = await import("@tursodatabase/database");
	let driver: DriverDatabase | undefined;
	try {
		driver = (await databaseModule.connect(databasePath, {
			readonly: options.readonly,
			fileMustExist: options.fileMustExist,
			timeout: options.timeoutMs ?? 5_000,
			defaultQueryTimeout: options.queryTimeoutMs,
			experimental: [...REQUIRED_EXPERIMENTAL_FEATURES],
		})) as unknown as DriverDatabase;
		driver.defaultSafeIntegers(true);
		await driver.exec("PRAGMA foreign_keys = ON");
		const foreignKeys = await driver.get<Record<string, unknown>>("PRAGMA foreign_keys");
		if (Number(foreignKeys?.foreign_keys ?? foreignKeys?.["0"]) !== 1) {
			throw new Error("Pinned Turso engine did not enable foreign-key enforcement");
		}

		const adapter = {
			get: <T>(sql: string, ...parameters: unknown[]) => driver!.get<T>(sql, ...parameters),
			transactionAsync: async <T>(operation: (transaction: TursoTransaction) => Promise<T>): Promise<T> =>
				driver!.transactionAsync(operation).immediate(),
		};
		const shouldMigrate = options.migrate ?? !options.readonly;
		const schemaVersion = shouldMigrate
			? await migrateTursoSchema(adapter)
			: await verifyTursoSchemaVersion(adapter);
		return new TursoDatabase({
			path: databasePath,
			allowedRoot: await realpath(options.allowedRoot),
			readonly: options.readonly === true,
			schemaVersion,
			driver,
		});
	} catch (error) {
		if (driver?.open) await driver.close();
		throw error;
	}
}

export function tursoDatabaseModeCanActivate(capabilityReport: { databaseModeEnabled: boolean }): boolean {
	return capabilityReport.databaseModeEnabled === true;
}

export { TURSO_SCHEMA_VERSION };
