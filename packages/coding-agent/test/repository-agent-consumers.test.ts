import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exportRepositorySessionToHtml } from "../src/export/html";
import { HistoryProtocolHandler } from "../src/internal-urls/history-protocol";
import { AgentRegistry } from "../src/registry/agent-registry";
import { registerPersistedSubagents } from "../src/registry/persisted-agents";
import { runRepositoryGc } from "../src/session/repository-gc";
import {
	RepositoryArtifactManager,
	readRepositoryTranscriptPage,
	type ExplicitRepositoryExportSource,
} from "../src/session/repository-consumers";
import { CURRENT_SESSION_VERSION, type SessionEntry, type SessionHeader } from "../src/session/session-entries";
import { JsonlSessionRepository } from "../src/session/repository/jsonl-repository";
import type {
	BranchId,
	ModeGeneration,
	ReplicaId,
	SessionLocator,
	SessionRepository,
	SessionTransferService,
} from "../src/session/repository/types";
import type { InternalUrl } from "../src/internal-urls/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];

afterEach(async () => {
	AgentRegistry.resetGlobalForTests();
	await Promise.all(tempRoots.splice(0).map(root => removeWithRetries(root)));
});

function header(id: string): SessionHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-09-15T12:00:00.000Z",
		cwd: "/fixture",
	};
}

function dbFacade(
	repository: JsonlSessionRepository,
): SessionRepository & SessionTransferService {
	return new Proxy(repository, {
		get(target, property) {
			if (property === "mode") return "db";
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as SessionRepository & SessionTransferService;
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "repository-agent-consumers-"));
	tempRoots.push(root);
	const sentinelRoot = path.join(root, "sentinel-jsonl-tree");
	await fs.mkdir(sentinelRoot);
	const sentinel = path.join(sentinelRoot, "must-not-touch.jsonl");
	await fs.writeFile(sentinel, "sentinel\n");
	const sentinelBefore = await fs.stat(sentinel);
	const raw = new JsonlSessionRepository({
		rootDir: path.join(root, "repository-storage"),
		replicaId: "replica:test" as ReplicaId,
		modeGeneration: "generation:test" as ModeGeneration,
		installationNamespace: "test",
	});
	const repository = dbFacade(raw);
	const health = await repository.health();
	const create = async (id: string) =>
		repository.createSession({
			expectedModeGeneration: health.modeGeneration,
			source: { sourceNamespace: "omp", installationNamespace: "test", nativeId: id },
			header: header(id),
			callerKey: id,
		});
	const main = await create("main");
	const child = await create("child");
	const advisor = await create("advisor");
	const grandchild = await create("grandchild");
	const mainLocator: SessionLocator = { branchId: main.branchId };
	const childLocator: SessionLocator = { branchId: child.branchId };
	const advisorLocator: SessionLocator = { branchId: advisor.branchId };
	await repository.registerRelatedResource({
		expectedModeGeneration: health.modeGeneration,
		locator: { owner: mainLocator, kind: "child-session", key: "Child" },
		target: childLocator,
	});
	await repository.registerRelatedResource({
		expectedModeGeneration: health.modeGeneration,
		locator: { owner: mainLocator, kind: "advisor-session", key: "Main/advisor" },
		target: advisorLocator,
	});
	await repository.registerRelatedResource({
		expectedModeGeneration: health.modeGeneration,
		locator: { owner: childLocator, kind: "child-session", key: "Grandchild" },
		target: { branchId: grandchild.branchId },
	});
	const append = async (branchId: BranchId, text: string) => {
		const current = await repository.getHeader({ branchId });
		const entry: SessionEntry = {
			type: "message",
			id: crypto.randomUUID(),
			parentId: null,
			timestamp: "2026-09-15T12:01:00.000Z",
			message: { role: "user", content: text, timestamp: Date.now() },
		};
		return repository.appendWithExpectedHead({
			expectedModeGeneration: health.modeGeneration,
			branchId,
			expectedHeadHash: current?.headEventHash ?? null,
			entries: [entry],
		});
	};
	await append(child.branchId, "parked child transcript");
	await append(advisor.branchId, "advisor transcript");
	return {
		root,
		sentinel,
		sentinelBefore,
		repository,
		health,
		mainLocator,
		childLocator,
		advisorLocator,
		grandchildLocator: { branchId: grandchild.branchId } satisfies SessionLocator,
	};
}

function historyUrl(id: string): InternalUrl {
	const url = new URL(`history://${id}`) as InternalUrl;
	Object.defineProperty(url, "rawHost", { value: id });
	return url;
}

describe("repository-backed agent consumers", () => {
	test("hydrates explicit child/advisor lineage and resolves parked history without JSONL scanning", async () => {
		const f = await fixture();
		const registry = AgentRegistry.global();
		await registerPersistedSubagents(registry, { repository: f.repository, locator: f.mainLocator });
		expect(registry.get("Child")?.parentId).toBe("Main");
		expect(registry.get("Grandchild")?.parentId).toBe("Child");
		expect(registry.get("Main/advisor")?.kind).toBe("advisor");
		expect(registry.get("Child")?.sessionFile).toBeNull();
		const resource = await new HistoryProtocolHandler().resolve(historyUrl("Child"), {
			sessionRepository: f.repository,
			sessionLocator: f.mainLocator,
		});
		expect(resource.content).toContain("parked child transcript");
		expect(resource.sourcePath).toBeUndefined();
		expect((await fs.readFile(f.sentinel, "utf8"))).toBe("sentinel\n");
	});

	test("pages Hub transcript reads by repository cursor", async () => {
		const f = await fixture();
		const first = await readRepositoryTranscriptPage(
			{ repository: f.repository, locator: f.childLocator },
			{ limit: 1 },
		);
		expect(first.entries).toHaveLength(1);
	});

	test("exports HTML only through an explicit transfer source", async () => {
		const f = await fixture();
		const output = path.join(f.root, "session.html");
		const source: ExplicitRepositoryExportSource = {
			repository: f.repository,
			transferService: f.repository,
			locator: f.mainLocator,
		};
		await exportRepositorySessionToHtml(source, output);
		const html = await fs.readFile(output, "utf8");
		expect(html).toContain("<!DOCTYPE html>");
		expect((await fs.readFile(f.sentinel, "utf8"))).toBe("sentinel\n");
	});

	test("allocates artifacts by explicit related-resource locator", async () => {
		const f = await fixture();
		const artifacts = new RepositoryArtifactManager(f.repository, f.mainLocator, f.health.modeGeneration);
		const id = await artifacts.save("artifact body", "read");
		expect(id).toBe("0");
		const target = await f.repository.resolveRelatedResource({
			owner: f.mainLocator,
			kind: "artifact",
			key: id,
		});
		expect(target?.branchId).toBeDefined();
		expect(new TextDecoder().decode(await artifacts.read(id))).toBe("artifact body");
	});

	test("drops only explicit logical intent and never treats absence as deletion", async () => {
		const f = await fixture();
		const result = await runRepositoryGc({
			repository: f.repository,
			expectedModeGeneration: f.health.modeGeneration,
			drop: [f.childLocator],
		});
		expect(result).toEqual({ requested: 1, dropped: 1 });
		expect(await f.repository.getHeader({ branchId: f.childLocator.branchId })).toBeUndefined();
		expect(await f.repository.getHeader({ branchId: f.advisorLocator.branchId })).toBeDefined();
		expect(await f.repository.getHeader({ branchId: f.grandchildLocator.branchId })).toBeDefined();
		const sentinelAfter = await fs.stat(f.sentinel);
		expect(sentinelAfter.mtimeMs).toBe(f.sentinelBefore.mtimeMs);
		expect((await fs.readFile(f.sentinel, "utf8"))).toBe("sentinel\n");
	});
});
