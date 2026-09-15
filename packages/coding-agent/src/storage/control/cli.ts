import type { StorageMode } from "../contracts";
import { executeStorageControlRequest } from "./service";
import {
	STORAGE_ACTIONS,
	type StorageAction,
	type StorageControlRequest,
	type StorageControlResult,
	type StorageControlService,
	type StorageReportEnvelope,
	type StorageReportFormat,
	type StorageReportSink,
} from "./types";

export interface ParsedStorageCommandInput {
	action?: string;
	mode?: string;
	dryRun?: boolean;
	allBranches?: boolean;
	source?: string;
	destination?: string;
	jobId?: string;
	reportPath?: string;
	format?: string;
}

const STORAGE_ACTION_SET: Record<StorageAction, true> = {
	inventory: true,
	normalize: true,
	import: true,
	export: true,
	sync: true,
	verify: true,
	backup: true,
	recover: true,
	mode: true,
};

function requireValue(action: StorageAction, name: string, value: string | undefined): string {
	if (value?.trim()) return value;
	throw new Error(`storage ${action} requires --${name} <path>`);
}

export function parseStorageCommand(input: ParsedStorageCommandInput): StorageControlRequest {
	const actionText = input.action ?? "mode";
	if (STORAGE_ACTION_SET[actionText as StorageAction] !== true) {
		throw new Error(`Unknown storage action "${actionText}". Expected one of: ${STORAGE_ACTIONS.join(", ")}`);
	}
	const action = actionText as StorageAction;
	const formatText = input.format ?? "json";
	if (formatText !== "json" && formatText !== "jsonl") {
		throw new Error("--format must be json or jsonl");
	}
	const format = formatText as StorageReportFormat;
	let targetMode: StorageMode | undefined;
	if (input.mode !== undefined) {
		if (action !== "mode") throw new Error("A mode argument is valid only for `omp storage mode [jsonl|db]`");
		if (input.mode !== "jsonl" && input.mode !== "db") throw new Error("Storage mode must be jsonl or db");
		targetMode = input.mode;
	}

	let source = input.source;
	let destination = input.destination;
	switch (action) {
		case "inventory":
			source = requireValue(action, "source", source);
			break;
		case "normalize":
		case "import":
			source = requireValue(action, "source", source);
			destination = requireValue(action, "destination", destination);
			break;
		case "export":
		case "backup":
			destination = requireValue(action, "destination", destination);
			break;
		case "sync":
		case "recover":
			source = requireValue(action, "source", source);
			destination = requireValue(action, "destination", destination);
			break;
		case "verify":
			if (!source && !destination && !input.jobId) {
				throw new Error("storage verify requires --source, --destination, or --job");
			}
			break;
		case "mode":
			break;
	}

	return {
		action,
		dryRun: input.dryRun === true,
		allBranches: input.allBranches === true,
		source,
		destination,
		jobId: input.jobId,
		reportPath: input.reportPath,
		format,
		targetMode,
	};
}

export function serializeStorageReport(envelope: StorageReportEnvelope): string {
	return envelope.request.format === "jsonl" ? JSON.stringify(envelope) : JSON.stringify(envelope, null, 2);
}

export async function runStorageCommand(
	request: StorageControlRequest,
	service: StorageControlService,
	sink: StorageReportSink,
	now: () => Date = () => new Date(),
): Promise<StorageReportEnvelope> {
	let result: StorageControlResult;
	if (request.action === "mode" && request.targetMode === undefined) {
		const status = await service.getStatus();
		result = {
			outcome: "completed",
			message: `Active storage mode: ${status.mode}`,
			status,
		};
	} else {
		result = await executeStorageControlRequest(service, request);
	}
	const envelope: StorageReportEnvelope = {
		schemaVersion: "omp.storage.control.v1",
		generatedAt: now().toISOString(),
		request,
		result,
	};
	const serialized = serializeStorageReport(envelope);
	if (request.reportPath) await sink.writeReport(request.reportPath, `${serialized}\n`);
	sink.writeStdout(`${serialized}\n`);
	return envelope;
}

export const processStorageReportSink: StorageReportSink = {
	writeStdout(serialized): void {
		process.stdout.write(serialized);
	},
	async writeReport(path, serialized): Promise<void> {
		await Bun.write(path, serialized);
	},
};
