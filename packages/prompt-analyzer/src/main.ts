#!/usr/bin/env bun
/**
 * CLI entry for the Buddha live prompt analyzer.
 *
 * Two-window workflow: this process owns the left window (concise stage logs on
 * **stderr**), the browser at the printed URL owns the right window.
 *
 * Flags: `--port <n>` (default 7717), `--model <id>`, `--verbose`, `--open`.
 */
import { postmortem } from "@oh-my-pi/pi-utils";
import { createTerminalLogger } from "./log";
import { type RunningServer, startServer } from "./server";
import { createSdkTransport } from "./transport-sdk";

const DEFAULT_PORT = 7717;

interface CliOptions {
	port: number;
	model?: string;
	verbose: boolean;
	open: boolean;
}

const USAGE = `Buddha live prompt analyzer

Usage: bun run packages/prompt-analyzer/src/main.ts [options]

Options:
  --port <n>     HTTP/WebSocket port (default ${DEFAULT_PORT})
  --model <id>   Model id, e.g. anthropic/claude-sonnet-5:low (env ANALYZER_MODEL)
  --verbose      Add protocol detail to the stderr log
  --open         Open the analyzer in the default browser
  --help         Show this help`;

function parseArgs(argv: readonly string[]): CliOptions | undefined {
	const options: CliOptions = {
		port: Number(process.env.ANALYZER_PORT ?? DEFAULT_PORT),
		model: process.env.ANALYZER_MODEL,
		verbose: false,
		open: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		switch (arg) {
			case "--help":
			case "-h":
				return undefined;
			case "--verbose":
			case "-v":
				options.verbose = true;
				break;
			case "--open":
				options.open = true;
				break;
			case "--port": {
				const value = Number(argv[++index]);
				if (!Number.isInteger(value) || value < 0 || value > 65535) {
					throw new Error(`--port expects a port number, got ${argv[index] ?? "nothing"}`);
				}
				options.port = value;
				break;
			}
			case "--model": {
				const value = argv[++index];
				if (!value) throw new Error("--model expects a model id");
				options.model = value;
				break;
			}
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
		throw new Error(`invalid ANALYZER_PORT: ${process.env.ANALYZER_PORT}`);
	}
	return options;
}

let options: CliOptions | undefined;
try {
	options = parseArgs(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
	process.exit(2);
}
if (!options) {
	process.stderr.write(`${USAGE}\n`);
	process.exit(0);
}

const log = createTerminalLogger(options.verbose);
const transport = createSdkTransport({ model: options.model, verbose: options.verbose });
await transport.start();
let server: RunningServer;
try {
	server = await startServer({ port: options.port, transport, verbose: options.verbose });
} catch (error) {
	// A refused bind must not strand the SDK sessions the transport just built.
	log.line(`Could not listen on port ${options.port}: ${error instanceof Error ? error.message : String(error)}`);
	await transport.dispose();
	process.exit(1);
}
const url = `http://localhost:${server.port}`;

log.line("Buddha prompt analyzer started");
log.line(`  ${url}`);

if (options.open) {
	try {
		Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], {
			stdout: "ignore",
			stderr: "ignore",
		}).unref();
	} catch (error) {
		log.line(`Could not open a browser: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Cleanup budget before the process leaves anyway; SDK teardown must not wedge exit. */
const SHUTDOWN_TIMEOUT_MS = 5000;

postmortem.register("prompt-analyzer", async () => {
	await server.close();
	log.detail("server closed");
	await transport.dispose();
	log.detail("transport disposed");
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
	if (shuttingDown) return;
	shuttingDown = true;
	log.detail(`${signal} received`);
	log.line("Shutting down");
	// A ref'd timer bounds a wedged teardown; the exit code stays 0 either way.
	const deadline = setTimeout(() => {
		log.line("Shutdown timed out; exiting anyway");
		process.exit(0);
	}, SHUTDOWN_TIMEOUT_MS);
	try {
		await postmortem.quit(0);
	} catch (error) {
		log.line(`Shutdown error: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(deadline);
	}
	process.exit(0);
};

// pi-utils' postmortem installs its own SIGINT/SIGTERM handlers that exit
// 128+signo (packages/utils/src/postmortem.ts:436 and :534). This CLI owns its
// exit status, so take both signals over; `postmortem.quit(0)` still runs every
// registered cleanup, including the ones the SDK installed.
process.removeAllListeners("SIGINT");
process.removeAllListeners("SIGTERM");
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
