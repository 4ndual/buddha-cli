import { loadWcdbNative, WcdbNativeUnavailableError } from "../native";
import type { WcdbOpenOptions } from "./protocol";
import type { WcdbNativeBatchAdapter } from "./server";

/**
 * Probe the exact ABI-v1 SQL request/response framing before repository mode is
 * admitted. Schema migrations are currently published as multi-statement SQL
 * scripts, while OWRQ deliberately prepares one statement per request item and
 * exposes no safe tail offset. We therefore never split or partially execute a
 * migration. Even a pre-initialized database remains disabled until native work
 * is interruptible without blocking the worker message loop.
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
		const blockers = [
			...(hasStorageSchema
				? []
				: ["schema bootstrap requires canonical individually framed migration statements"]),
			"synchronous ABI calls cannot satisfy active cancellation",
		];
		throw new WcdbNativeUnavailableError(
			`WCDB SQL batch ABI verified (SQLite ${String(sqliteVersion ?? "unknown")}, schema=${hasStorageSchema ? "present" : "absent"}), but repository capability is disabled: ${blockers.join("; ")}`,
		);
	} finally {
		await handle.close();
	}
}
