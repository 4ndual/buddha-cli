import { describe, expect, test } from "bun:test";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";

describe("extension runtime services", () => {
	test("publishes a namespaced service to the session context", async () => {
		const runtime = new ExtensionRuntime();
		const service = { snapshot: () => "ready" };
		await loadExtensionFromFactory(
			pi => pi.registerExtensionService("buddha.hub-inbox", service),
			"/tmp",
			{ emit: () => {} } as never,
			runtime,
			"profile:buddha-v1",
		);

		expect(runtime.extensionServices.get("buddha.hub-inbox")).toEqual({
			value: service,
			sourceId: "profile:buddha-v1",
		});
	});

	test("rejects ambiguous service ownership", async () => {
		const runtime = new ExtensionRuntime();
		await loadExtensionFromFactory(
			pi => pi.registerExtensionService("buddha.hub-inbox", {}),
			"/tmp",
			{ emit: () => {} } as never,
			runtime,
			"first",
		);

		await expect(
			loadExtensionFromFactory(
				pi => pi.registerExtensionService("buddha.hub-inbox", {}),
				"/tmp",
				{ emit: () => {} } as never,
				runtime,
				"second",
			),
		).rejects.toThrow('Extension service "buddha.hub-inbox" is already registered by first');
	});

	test("rolls back services when an extension factory fails", async () => {
		const runtime = new ExtensionRuntime();

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerExtensionService("broken.service", {});
					throw new Error("boom");
				},
				"/tmp",
				{ emit: () => {} } as never,
				runtime,
				"broken",
			),
		).rejects.toThrow("boom");
		expect(runtime.extensionServices.size).toBe(0);
	});
});
