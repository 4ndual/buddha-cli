#!/usr/bin/env bun
import { sha256File, stableJson, type InventoryReport } from "./inventory";

function usage(): never {
	process.stderr.write("Usage: bun summarize-receipt.ts REPORT SUMMARY UNKNOWN_QUEUE\n");
	process.exit(2);
}

const [reportPath, summaryPath, queuePath] = process.argv.slice(2);
if (!reportPath || !summaryPath || !queuePath) usage();
const raw: unknown = await Bun.file(reportPath).json();
if (typeof raw !== "object" || raw === null || !("schema" in raw) || raw.schema !== "omp.wcdb.inventory.v1" || !("records" in raw) || !Array.isArray(raw.records)) {
	throw new Error("Input is not an OMP WCDB inventory report");
}
const report = raw as InventoryReport;
const provenanceByStatus: Record<string, number> = {};
const observationsByField: Record<string, number> = {};
const uniqueCopies = new Map<string, number>();
let branchObservations = 0;
let sessionIdObservations = 0;
for (const record of report.records) {
	for (const observation of record.observations) {
		provenanceByStatus[observation.status] = (provenanceByStatus[observation.status] ?? 0) + 1;
		observationsByField[observation.field] = (observationsByField[observation.field] ?? 0) + 1;
		if (observation.field === "gitBranch") branchObservations++;
		if (observation.field === "nativeSessionId") sessionIdObservations++;
	}
	if (record.copySha256) uniqueCopies.set(record.copySha256, Math.max(uniqueCopies.get(record.copySha256) ?? 0, record.size));
}
const queue = report.records
	.filter(record => record.disposition === "pending" || record.disposition === "quarantined" || record.format.startsWith("unknown") || record.format === "unrecognized")
	.map(record => ({ sourcePath: record.sourcePath, harness: record.harness, namespace: record.namespace, format: record.format, size: record.size, sha256: record.sha256After ?? record.sha256Before, copySha256: record.copySha256, disposition: record.disposition, reason: record.reason }))
	.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
const reportSha256 = await sha256File(reportPath);
const uniqueCopyBytes = [...uniqueCopies.values()].reduce((sum, size) => sum + size, 0);
const summary = {
	schema: "omp.wcdb.inventory-summary.v1",
	reportSha256,
	snapshotAt: report.snapshotAt,
	since: report.since,
	mode: report.mode,
	rootCount: report.roots.length,
	totals: report.totals,
	adapterMatrix: report.adapterMatrix,
	metadataProvenance: { byStatus: provenanceByStatus, observationsByField, branchObservations, sessionIdObservations },
	copyAccounting: { uniqueCopyObjects: uniqueCopies.size, uniqueCopyBytes, logicalCopiedBytes: report.totals.byDisposition.copied.bytes + report.totals.byDisposition.quarantined.bytes, hashAlgorithm: "sha256", objectLayout: "objects/sha256/<prefix>/<digest>" },
	unknownCorruptQueue: { path: queuePath, records: queue.length },
	preflight: report.preflight,
	noProductionMutation: report.noProductionMutation,
};
await Promise.all([Bun.write(summaryPath, stableJson(summary)), Bun.write(queuePath, stableJson({ schema: "omp.wcdb.unknown-corrupt-queue.v1", reportSha256, records: queue }))]);
process.stdout.write(stableJson({ summaryPath, queuePath, reportSha256, queueRecords: queue.length, uniqueCopyObjects: uniqueCopies.size, uniqueCopyBytes }));
