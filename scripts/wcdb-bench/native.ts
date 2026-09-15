import * as fs from "node:fs/promises";
import type { EngineReceipt, NativeGate } from "./types";
import { canonicalJson, sha256File } from "./util";
import { DIRECT_SQLITE_SETTINGS } from "./sqlite";

interface NativeRunOptions {
	gatePath: string;
	corpusRoot: string;
	databasePath: string;
	exportPath: string;
	iterations: number;
	maxInputBytes: number;
	maxRecordBytes: number;
	scale: number;
}

export interface NativeRunResult {
	engine: EngineReceipt;
	gateSha256: string | null;
	librarySha256: string | null;
	buildManifestSha256: string | null;
	settingsMatched: boolean;
}

function blocked(reason: string): NativeRunResult {
	return {
		engine: {
			status: "blocked",
			reason,
			engine: "wcdb-bridge",
			version: null,
			settings: {},
			metrics: {},
			bridgeCallTotal: 0,
		},
		gateSha256: null,
		librarySha256: null,
		buildManifestSha256: null,
		settingsMatched: false,
	};
}

function parseGate(value: unknown): NativeGate | null {
	if (!value || typeof value !== "object") return null;
	if (!("schemaVersion" in value) || value.schemaVersion !== 1) return null;
	if (!("status" in value) || value.status !== "passed") return null;
	if (!("protocol" in value) || value.protocol !== "wcdb-bench-ndjson-v1") return null;
	if (!("bridgeCommand" in value) || !Array.isArray(value.bridgeCommand) || !value.bridgeCommand.every(item => typeof item === "string")) return null;
	if (!("libraryPath" in value) || typeof value.libraryPath !== "string") return null;
	if (!("buildManifestPath" in value) || typeof value.buildManifestPath !== "string") return null;
	if (!("engineVersion" in value) || typeof value.engineVersion !== "string") return null;
	if (!("settings" in value) || !value.settings || typeof value.settings !== "object") return null;
	return value as NativeGate;
}

function parseEngine(value: unknown): EngineReceipt | null {
	if (!value || typeof value !== "object") return null;
	if (!("engine" in value) || value.engine !== "wcdb-bridge") return null;
	if (!("status" in value) || value.status !== "measured") return null;
	if (!("metrics" in value) || !value.metrics || typeof value.metrics !== "object") return null;
	if (!("settings" in value) || !value.settings || typeof value.settings !== "object") return null;
	if (!("bridgeCallTotal" in value) || typeof value.bridgeCallTotal !== "number") return null;
	return value as EngineReceipt;
}

export async function runNativeBridge(options: NativeRunOptions): Promise<NativeRunResult> {
	let gateText: string;
	try {
		gateText = await Bun.file(options.gatePath).text();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return blocked(`native capability gate does not exist: ${options.gatePath}`);
		return blocked(`native capability gate is unreadable: ${String(error)}`);
	}
	let gateValue: unknown;
	try {
		gateValue = JSON.parse(gateText);
	} catch {
		return blocked("native capability gate is not valid JSON");
	}
	const gate = parseGate(gateValue);
	if (!gate) return blocked("native capability gate did not assert the passed wcdb-bench-ndjson-v1 protocol");
	const gateSha256 = await sha256File(options.gatePath);
	let librarySha256: string;
	let buildManifestSha256: string;
	try {
		const libraryStat = await fs.stat(gate.libraryPath);
		const manifestStat = await fs.stat(gate.buildManifestPath);
		if (!libraryStat.isFile() || !manifestStat.isFile()) return blocked("native gate references non-files");
		librarySha256 = await sha256File(gate.libraryPath);
		buildManifestSha256 = await sha256File(gate.buildManifestPath);
	} catch (error) {
		return blocked(`native gate references unavailable pinned inputs: ${String(error)}`);
	}
	const requestedSettings = { ...DIRECT_SQLITE_SETTINGS };
	if (canonicalJson(gate.settings) !== canonicalJson(requestedSettings)) {
		const result = blocked("native gate settings do not exactly match the direct SQLite durability/query/data settings");
		result.gateSha256 = gateSha256;
		result.librarySha256 = librarySha256;
		result.buildManifestSha256 = buildManifestSha256;
		return result;
	}
	const child = Bun.spawn(gate.bridgeCommand, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	child.stdin.write(
		JSON.stringify({
			protocol: "wcdb-bench-ndjson-v1",
			action: "benchmark",
			corpusRoot: options.corpusRoot,
			databasePath: options.databasePath,
			exportPath: options.exportPath,
			iterations: options.iterations,
			maxInputBytes: options.maxInputBytes,
			maxRecordBytes: options.maxRecordBytes,
			scale: options.scale,
			settings: requestedSettings,
		}),
	);
	child.stdin.end();
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		const result = blocked(`native bridge benchmark exited ${exitCode}: ${stderr.slice(0, 2000)}`);
		result.gateSha256 = gateSha256;
		result.librarySha256 = librarySha256;
		result.buildManifestSha256 = buildManifestSha256;
		return result;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		const result = blocked("native bridge benchmark returned invalid JSON");
		result.gateSha256 = gateSha256;
		result.librarySha256 = librarySha256;
		result.buildManifestSha256 = buildManifestSha256;
		return result;
	}
	const engine = parseEngine(parsed);
	if (!engine) {
		const result = blocked("native bridge benchmark receipt failed structural validation");
		result.gateSha256 = gateSha256;
		result.librarySha256 = librarySha256;
		result.buildManifestSha256 = buildManifestSha256;
		return result;
	}
	const settingsMatched = canonicalJson(engine.settings) === canonicalJson(requestedSettings);
	if (!settingsMatched) {
		engine.status = "blocked";
		engine.reason = "native receipt settings differ from direct SQLite baseline";
	}
	return { engine, gateSha256, librarySha256, buildManifestSha256, settingsMatched };
}
