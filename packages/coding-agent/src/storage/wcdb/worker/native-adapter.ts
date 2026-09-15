import { WCDB_SCHEMA_BOOTSTRAP_STATEMENTS, WCDB_SCHEMA_CONNECTION_STATEMENTS } from "../../schema";
import { loadWcdbNative, WcdbNativeUnavailableError } from "../native";
import type { WcdbOpenOptions } from "./protocol";
import type { WcdbNativeBatchAdapter } from "./server";

/**
 * Probe the exact ABI-v1 SQL framing and bootstrap the pinned schema with
 * canonical one-statement frames. Capability remains disabled because Bun's
 * synchronous FFI call blocks the worker loop that must deliver active
 * cancellation and timeouts.
 */
export async function createNativeWcdbAdapter(options: WcdbOpenOptions): Promise<WcdbNativeBatchAdapter> {
	const handle = loadWcdbNative({
		libraryPath: options.nativeLibraryPath,
		databasePath: options.databasePath,
		create: true,
	});
	try {
		await handle.executeBatch(
			{
				transactional: false,
				statements: WCDB_SCHEMA_CONNECTION_STATEMENTS.map(sql => ({ kind: "execute" as const, sql })),
			},
			{ timeoutMs: Math.min(options.busyTimeoutMs ?? 1_000, 5_000) },
		);
		const probe = await handle.executeBatch(
			{
				transactional: false,
				statements: [
					{ kind: "query", sql: "SELECT sqlite_version() AS sqlite_version", maxRows: 1 },
					{
						kind: "query",
						sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_meta' LIMIT 1",
						maxRows: 1,
					},
				],
			},
			{ timeoutMs: Math.min(options.busyTimeoutMs ?? 1_000, 5_000) },
		);
		const sqliteVersion = probe.statements[0]?.rows[0]?.[0];
		let hasStorageSchema = probe.statements[1]?.rows.length === 1;
		if (!hasStorageSchema) {
			await handle.executeBatch(
				{
					transactional: true,
					statements: WCDB_SCHEMA_BOOTSTRAP_STATEMENTS.map(sql => ({ kind: "execute" as const, sql })),
				},
				{ timeoutMs: Math.max(options.busyTimeoutMs ?? 1_000, 30_000) },
			);
			const verified = await handle.executeBatch(
				{
					transactional: false,
					statements: [
						{
							kind: "query",
							sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_meta' LIMIT 1",
							maxRows: 1,
						},
					],
				},
				{ timeoutMs: Math.min(options.busyTimeoutMs ?? 1_000, 5_000) },
			);
			hasStorageSchema = verified.statements[0]?.rows.length === 1;
		}
		if (!hasStorageSchema) {
			throw new WcdbNativeUnavailableError("WCDB schema bootstrap completed without creating storage_meta");
		}
		throw new WcdbNativeUnavailableError(
			`WCDB SQL batch ABI and schema bootstrap verified (SQLite ${String(sqliteVersion ?? "unknown")}), but repository capability is disabled: synchronous ABI calls cannot satisfy active cancellation`,
		);
	} finally {
		await handle.close();
	}
}
