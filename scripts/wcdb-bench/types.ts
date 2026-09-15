export type GateStatus = "measured" | "blocked" | "skipped";

export interface Distribution {
	iterations: number;
	minMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
	meanMs: number;
}

export interface MemorySnapshot {
	rssBytes: number;
	peakRssBytes: number | null;
	pssBytes: number | null;
	privateBytes: number | null;
	bunHeapUsedBytes: number;
	bunHeapTotalBytes: number;
	externalBytes: number;
	osMemAvailableBytes: number | null;
	osMemFreeBytes: number | null;
	osCachedBytes: number | null;
}

export interface ResourceDelta {
	cpuUserMicros: number;
	cpuSystemMicros: number;
	maxRssBytes: number;
	peakPssBytes: number | null;
	before: MemorySnapshot;
	after: MemorySnapshot;
}

export interface FileSizes {
	databaseBytes: number;
	walBytes: number;
	shmBytes: number;
	totalBytes: number;
	pageBytes: number | null;
	freelistBytes: number | null;
	indexBytes: number | null;
}

export interface MetricReceipt {
	status: GateStatus;
	reason?: string;
	latency?: Distribution;
	resources?: ResourceDelta;
	bridgeCalls?: number;
	operationCalls?: number;
	rows?: number;
	bytes?: number;
	throughputRowsPerSecond?: number;
	throughputBytesPerSecond?: number;
	diskBefore?: FileSizes;
	diskAfter?: FileSizes;
	details?: Record<string, unknown>;
}

export interface CorpusRecordDisposition {
	recordId: string;
	fileSha256: string;
	recordSha256: string;
	path: string;
	line: number | null;
	bytes: number;
	kind: string;
	disposition: "normalized" | "imported" | "quarantined" | "copied-awaiting-normalization" | "excluded";
	reason: string;
	originId: string | null;
	branchHead: string | null;
	contextHash: string | null;
	parentHash: string | null;
	attachmentHashes: string[];
	provenance: Record<string, string | number | boolean | null>;
}

export interface CorpusAccounting {
	status: GateStatus;
	reason?: string;
	root: string;
	files: number;
	records: number;
	bytes: number;
	fileManifestHash: string;
	dispositions: Record<string, number>;
	parseErrors: number;
	missingParents: number;
	cycles: number;
	identityConflicts: number;
	branchHeads: number;
	attachmentReferences: number;
	missingAttachments: number;
	contextHashes: number;
	recordsPath: string;
}

export interface EngineReceipt {
	status: GateStatus;
	reason?: string;
	engine: "direct-sqlite" | "wcdb-bridge";
	version: string | null;
	settings: Record<string, string | number | boolean | null>;
	pins?: {
		wcdbCommit: string;
		sqliteVersion: string;
		librarySha256: string;
		bridgeExecutableSha256: string;
		buildManifestSha256: string;
	};
	metrics: Record<string, MetricReceipt>;
	bridgeCallTotal: number;
}

export interface BenchmarkReceipt {
	schemaVersion: 1;
	createdAt: string;
	status: GateStatus;
	machine: {
		hostname: string;
		platform: string;
		arch: string;
		kernel: string;
		cpuModel: string;
		logicalCpus: number;
		filesystem: string;
		mountOptions: string;
		bunVersion: string;
	};
	pins: {
		harnessCommit: string | null;
		nativeGatePath: string;
		nativeGateSha256: string | null;
		nativeLibrarySha256: string | null;
		nativeBuildManifestSha256: string | null;
		nativeBridgeExecutableSha256: string | null;
		wcdbCommit: string | null;
		sqliteVersion: string | null;
	};
	limits: {
		maxInputBytes: number;
		maxRecordBytes: number;
		iterations: number;
		scale: number;
	};
	corpus: CorpusAccounting;
	fixtures: {
		actualRows: number;
		scaledRows: number;
		longestEntries: number;
		forkBranches: number;
		giantOutputBytes: number;
	};
	engines: EngineReceipt[];
	directSqliteTax: {
		status: GateStatus;
		reason: string;
		matchedSettings: boolean;
		metrics: Record<string, { wcdbMs: number; directSqliteMs: number; ratio: number }>;
	};
	concurrency: MetricReceipt;
	fsync: MetricReceipt;
	exportRecovery: {
		status: GateStatus;
		reason: string;
		exportSha256: string | null;
		reimportDatabaseSha256: string | null;
		rowsExported: number;
		rowsReimported: number;
		semanticHashBefore: string | null;
		semanticHashAfter: string | null;
	};
	claims: Array<{ gate: string; status: GateStatus; evidence: string }>;
}

export interface NativeGate {
	schemaVersion: 1;
	status: "passed";
	bridgeCommand: string[];
	bridgeExecutablePath: string;
	bridgeExecutableSha256: string;
	libraryPath: string;
	librarySha256: string;
	buildManifestPath: string;
	buildManifestSha256: string;
	wcdbCommit: string;
	sqliteVersion: string;
	engineVersion: string;
	protocol: "wcdb-bench-ndjson-v1";
	settings: Record<string, string | number | boolean | null>;
}
