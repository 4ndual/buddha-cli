#!/usr/bin/env bun
import * as path from "node:path";
import { inventory, stableJson, type InventoryOptions, type InventoryRoot } from "./inventory";

interface Arguments {
	rootsFile: string;
	destination: string;
	report: string;
	mode: "plan" | "copy";
	since: Date;
	copyBudgetBytes?: number;
	retries: number;
}

function usage(): never {
	process.stderr.write("Usage: bun inventory-cli.ts --roots-file FILE --destination DIR --report FILE --since ISO [--mode plan|copy] [--copy-budget-bytes N] [--retries N]\n");
	process.exit(2);
}

function parseArguments(argv: string[]): Arguments {
	const values: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || value === undefined) usage();
		values[key.slice(2)] = value;
	}
	const rootsFile = values["roots-file"];
	const destination = values.destination;
	const report = values.report;
	const since = new Date(values.since ?? "invalid");
	const mode = values.mode ?? "plan";
	if (!rootsFile || !destination || !report || Number.isNaN(since.getTime()) || (mode !== "plan" && mode !== "copy")) usage();
	const copyBudgetBytes = values["copy-budget-bytes"] === undefined ? undefined : Number(values["copy-budget-bytes"]);
	const retries = values.retries === undefined ? 1 : Number(values.retries);
	if ((copyBudgetBytes !== undefined && (!Number.isSafeInteger(copyBudgetBytes) || copyBudgetBytes < 0)) || !Number.isSafeInteger(retries) || retries < 0) usage();
	return { rootsFile: path.resolve(rootsFile), destination: path.resolve(destination), report: path.resolve(report), since, mode, copyBudgetBytes, retries };
}

async function main(): Promise<void> {
	const args = parseArguments(process.argv.slice(2));
	const parsed: unknown = await Bun.file(args.rootsFile).json();
	if (!Array.isArray(parsed)) throw new Error("Roots file must contain an array");
	const roots: InventoryRoot[] = parsed.map((value, index) => {
		if (typeof value !== "object" || value === null || !("name" in value) || !("harness" in value) || !("namespace" in value) || !("path" in value) || !("policy" in value)) {
			throw new Error(`Invalid root descriptor at index ${index}`);
		}
		const name = value.name;
		const harness = value.harness;
		const namespace = value.namespace;
		const rootPath = value.path;
		const policy = value.policy;
		const runtimeVersion = "runtimeVersion" in value ? value.runtimeVersion : undefined;
		if (typeof name !== "string" || typeof harness !== "string" || typeof namespace !== "string" || typeof rootPath !== "string" || !["session-tree", "attachment-tree", "manifest-tree", "archive-tree"].includes(String(policy)) || (runtimeVersion !== undefined && typeof runtimeVersion !== "string")) {
			throw new Error(`Invalid root descriptor fields at index ${index}`);
		}
		return { name, harness, namespace, path: path.resolve(rootPath), policy: policy as InventoryRoot["policy"], runtimeVersion };
	});
	const options: InventoryOptions = { roots, destination: args.destination, since: args.since, mode: args.mode, copyBudgetBytes: args.copyBudgetBytes, retries: args.retries };
	const result = await inventory(options);
	await Bun.write(args.report, stableJson(result));
	process.stdout.write(`${stableJson({ report: args.report, totals: result.totals, preflight: result.preflight, noProductionMutation: result.noProductionMutation })}`);
	if (!result.noProductionMutation.originalsStable) process.exitCode = 1;
}

await main();
