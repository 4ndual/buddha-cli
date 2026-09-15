import { loadWcdbNative, WcdbNativeUnavailableError } from "../native";
import type { WcdbOpenOptions } from "./protocol";
import type { WcdbNativeBatchAdapter } from "./server";

/**
 * Probe the exact ABI-v1 SQL request/response framing before repository mode is
 * admitted. The pinned WCDB 2.1.16 build exposes SQLite 3.27.2, while logical
 * schema v1 currently contains STRICT tables (SQLite 3.37+). Long synchronous
 * native calls would also prevent worker message cancellation, so no operation
 * adapter is returned until both schema and interruptibility gates pass.
 */
export async function createNativeWcdbAdapter(options: WcdbOpenOptions): Promise<WcdbNativeBatchAdapter> {
	const handle = loadWcdbNative({
		libraryPath: options.nativeLibraryPath,
		databasePath: options.databasePath,
		create: true,
	});
	try {
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
		const hasStorageSchema = probe.statements[1]?.rows.length === 1;
		throw new WcdbNativeUnavailableError(
			`WCDB SQL batch ABI verified (SQLite ${String(sqliteVersion ?? "unknown")}, schema=${hasStorageSchema ? "present" : "absent"}), but repository capability is disabled: schema v1 requires STRICT tables unavailable in pinned SQLite 3.27.2 and synchronous ABI calls cannot satisfy active cancellation`,
		);
	} finally {
		await handle.close();
	}
}
