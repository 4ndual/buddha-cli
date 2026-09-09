/**
 * Child-process harness for the stdout-purity case.
 *
 * Runs a complete analysis through the real server with `verbose: true` (the
 * loudest logging mode) and exits. The parent test asserts that everything
 * this process wrote to stdout is empty and that the log landed on stderr.
 */
import { createTerminalLogger } from "../../src/log";
import { startServer } from "../../src/server";
import { createFixtureTransport } from "./fake-transport";
import { SIMPLE_PROMPT } from "./prompts";
import { analyzeResponse, categorizeResponse, paraphraseResponse, verifyResponse } from "./stage-responses";

// The pipeline's stage lines go through the real terminal logger here, exactly
// as `transport-sdk.ts` wires them in production.
const transport = createFixtureTransport(
	{
		paraphrase: {
			json: paraphraseResponse([{ source: SIMPLE_PROMPT, paraphrase: "Build a login page." }]),
			chunks: ['{"paraphrase"', ':"Build a login page.","parts":[]}'],
		},
		categorize: { json: categorizeResponse([{ text: SIMPLE_PROMPT, categories: ["DIRECT"] }]) },
		analyze: {
			json: analyzeResponse(
				[{ text: SIMPLE_PROMPT, subcategories: ["build_request"], tags: ["auth"] }],
				[{ id: "INT-01", answer: "Build a login page.", source: SIMPLE_PROMPT }],
			),
		},
		verify: { json: verifyResponse({}) },
	},
	createTerminalLogger(true),
);

await transport.start();
const server = await startServer({ port: 0, transport, verbose: true });

const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
const opened = Promise.withResolvers<void>();
socket.addEventListener("open", () => opened.resolve(), { once: true });
socket.addEventListener("error", () => opened.reject(new Error("harness socket failed")), { once: true });
await opened.promise;

const finished = Promise.withResolvers<void>();
socket.addEventListener("message", message => {
	const event = JSON.parse(String(message.data)) as { type: string };
	if (event.type === "run_verified" || event.type === "run_cancelled" || event.type === "run_stale") {
		finished.resolve();
	}
});
socket.send(JSON.stringify({ type: "analyze", rawPrompt: SIMPLE_PROMPT }));
await finished.promise;

socket.close();
await server.close();
await transport.dispose();
process.exit(0);
