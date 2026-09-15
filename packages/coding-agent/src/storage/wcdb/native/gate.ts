export const WCDB_MANDATORY_NATIVE_GATES = [
	"ffiLoad",
	"wal",
	"synchronousFull",
	"foreignKeysEnabled",
	"foreignKeyEnforced",
	"busyTimeoutConfigured",
	"busyTimeoutAndCancellation",
	"int64BinaryUtf8",
	"fts5Tokenizer",
	"fts5ExternalContentRebuild",
	"applicationZstd",
	"backupReopen",
	"reopenAfterCrash",
	"shutdown",
	"lazyImport",
] as const;

export type WcdbMandatoryNativeGate = (typeof WCDB_MANDATORY_NATIVE_GATES)[number];

export interface WcdbNativeGateResult {
	status: "pass" | "fail" | "unsupported";
	measured: boolean;
	detail: string;
}

export interface WcdbNativeGateReceipt {
	schemaVersion: 1;
	measured: boolean;
	buildId: string | null;
	gates: Partial<Record<WcdbMandatoryNativeGate, WcdbNativeGateResult>>;
	mandatory: readonly string[];
	capability: {
		modeEnabled: boolean;
		releaseQualified: boolean;
		reason: string;
	};
}

export interface WcdbNativeGateDecision {
	enabled: boolean;
	releaseQualified: boolean;
	missing: readonly WcdbMandatoryNativeGate[];
	failed: readonly WcdbMandatoryNativeGate[];
	reason: string;
}

/**
 * Fail-closed mode gate. A locally passing receipt is not a production release
 * qualification; packaging/cutover must set releaseQualified in a later owned stage.
 */
export function evaluateWcdbNativeGate(receipt: WcdbNativeGateReceipt | null | undefined): WcdbNativeGateDecision {
	if (!receipt || receipt.schemaVersion !== 1 || !receipt.measured) {
		return {
			enabled: false,
			releaseQualified: false,
			missing: [...WCDB_MANDATORY_NATIVE_GATES],
			failed: [],
			reason: "A measured WCDB native gate receipt is required",
		};
	}
	const missing: WcdbMandatoryNativeGate[] = [];
	const failed: WcdbMandatoryNativeGate[] = [];
	for (const name of WCDB_MANDATORY_NATIVE_GATES) {
		const gate = receipt.gates[name];
		if (!gate?.measured) missing.push(name);
		else if (gate.status !== "pass") failed.push(name);
	}
	const receiptNamesMatch = receipt.mandatory.length === WCDB_MANDATORY_NATIVE_GATES.length
		&& WCDB_MANDATORY_NATIVE_GATES.every((name) => receipt.mandatory.includes(name));
	if (!receiptNamesMatch) {
		return {
			enabled: false,
			releaseQualified: false,
			missing,
			failed,
			reason: "WCDB receipt mandatory gate set does not match this runtime",
		};
	}
	const buildMatches = receipt.buildId?.startsWith("omp-wcdb-bridge/1;wcdb/2.1.16;sqlite/3.27.2;protocol/1") === true;
	const gatesPass = missing.length === 0 && failed.length === 0 && receipt.capability.modeEnabled && buildMatches;
	const releaseQualified = gatesPass && receipt.capability.releaseQualified;
	return {
		enabled: releaseQualified,
		releaseQualified,
		missing,
		failed,
		reason: !buildMatches
			? "WCDB receipt build identifier does not match the pinned runtime"
			: !gatesPass
				? receipt.capability.reason
				: releaseQualified
					? "WCDB native gates and release qualification pass"
					: "WCDB native gates pass locally, but production release qualification is absent",
	};
}
