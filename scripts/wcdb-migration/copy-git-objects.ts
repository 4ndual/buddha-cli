#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256File, stableJson } from "./inventory";

interface ObjectSpec {
	gitObject: string;
	expectedSha256: string;
	expectedSize: number;
	logicalPath: string;
}

const [repositoryArg, destinationArg, receiptArg, specsArg] = process.argv.slice(2);
if (!repositoryArg || !destinationArg || !receiptArg || !specsArg) {
	throw new Error("Usage: bun copy-git-objects.ts REPOSITORY DESTINATION RECEIPT SPECS_JSON");
}
const repository = await fs.realpath(repositoryArg);
const destination = path.resolve(destinationArg);
const relativeDestination = path.relative(repository, destination);
if (relativeDestination === "" || (!relativeDestination.startsWith(`..${path.sep}`) && relativeDestination !== "..")) {
	throw new Error("Destination must not be inside the source repository");
}
const parsed: unknown = JSON.parse(specsArg);
if (!Array.isArray(parsed)) throw new Error("Object specs must be a JSON array");
const specs: ObjectSpec[] = parsed.map((candidate, index) => {
	if (typeof candidate !== "object" || candidate === null || !("gitObject" in candidate) || !("expectedSha256" in candidate) || !("expectedSize" in candidate) || !("logicalPath" in candidate)) throw new Error(`Invalid object spec ${index}`);
	const gitObject = candidate.gitObject;
	const expectedSha256 = candidate.expectedSha256;
	const expectedSize = candidate.expectedSize;
	const logicalPath = candidate.logicalPath;
	if (typeof gitObject !== "string" || !/^[0-9a-f]{40}$/u.test(gitObject) || typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expectedSha256) || typeof expectedSize !== "number" || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || typeof logicalPath !== "string") throw new Error(`Invalid object spec fields ${index}`);
	return { gitObject, expectedSha256, expectedSize, logicalPath };
});
await fs.mkdir(destination, { recursive: true });
const records = [];
for (const spec of specs.sort((left, right) => left.gitObject.localeCompare(right.gitObject))) {
	const temporary = path.join(destination, `.git-object-${process.pid}-${crypto.randomUUID()}.partial-wcdb-inventory`);
	const child = Bun.spawn(["git", "cat-file", "blob", spec.gitObject], { cwd: repository, stdout: "pipe", stderr: "pipe" });
	await Bun.write(temporary, child.stdout);
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		await fs.rm(temporary, { force: true });
		throw new Error(`git cat-file failed for ${spec.gitObject}: ${await new Response(child.stderr).text()}`);
	}
	const stat = await fs.stat(temporary);
	const sha256 = await sha256File(temporary);
	if (stat.size !== spec.expectedSize || sha256 !== spec.expectedSha256) {
		await fs.rm(temporary, { force: true });
		throw new Error(`Git object verification failed for ${spec.gitObject}`);
	}
	const finalPath = path.join(destination, "objects", "sha256", sha256.slice(0, 2), sha256);
	await fs.mkdir(path.dirname(finalPath), { recursive: true });
	try {
		await fs.link(temporary, finalPath);
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
		if ((await sha256File(finalPath)) !== sha256) throw new Error(`Existing object mismatch: ${finalPath}`);
	} finally {
		await fs.rm(temporary, { force: true });
	}
	records.push({ ...spec, copyPath: finalPath, copySha256: sha256, disposition: "copied", reason: "verified-git-blob-extraction" });
}
await Bun.write(receiptArg, stableJson({ schema: "omp.wcdb.git-object-copy-receipt.v1", repository, destination, records, noProductionMutation: { sourceWrites: 0, sourceDeletes: 0, sourcePermissionChanges: 0 } }));
process.stdout.write(stableJson({ receipt: receiptArg, copied: records.length, bytes: records.reduce((sum, record) => sum + record.expectedSize, 0) }));
