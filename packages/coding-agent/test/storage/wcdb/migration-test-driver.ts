export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface AdapterRequest {
	protocol: "omp-wcdb-test-driver-v1";
	workspace: string;
	operation: string;
	input: JsonValue;
}

interface AdapterSuccess<T extends JsonValue> {
	ok: true;
	result: T;
}

interface AdapterFailure {
	ok: false;
	error: {
		code: string;
		message: string;
	};
}

export interface RawAdapterResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export class AdapterInvocationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AdapterInvocationError";
		this.code = code;
	}
}

function parseAdapterArgv(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => typeof item !== "string" || !item)) {
		throw new Error("OMP_WCDB_TEST_ADAPTER must be a JSON array of non-empty argv strings");
	}
	return parsed;
}

export const wcdbTestAdapterArgv = parseAdapterArgv(process.env.OMP_WCDB_TEST_ADAPTER);
export const hasWcdbTestAdapter = wcdbTestAdapterArgv !== undefined;

export class WcdbMigrationTestDriver {
	readonly #argv: string[];
	readonly #workspace: string;

	constructor(workspace: string, argv: string[] = wcdbTestAdapterArgv ?? []) {
		if (argv.length === 0) throw new Error("WCDB integration adapter is not configured");
		this.#argv = argv;
		this.#workspace = workspace;
	}

	async invokeRaw(operation: string, input: JsonValue = {}): Promise<RawAdapterResult> {
		const request: AdapterRequest = {
			protocol: "omp-wcdb-test-driver-v1",
			workspace: this.#workspace,
			operation,
			input,
		};
		const process = Bun.spawn(this.#argv, {
			cwd: this.#workspace,
			env: { ...Bun.env, OMP_WCDB_TEST_WORKSPACE: this.#workspace },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		process.stdin.write(JSON.stringify(request));
		process.stdin.end();
		const [exitCode, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	}

	async invoke<T extends JsonValue>(operation: string, input: JsonValue = {}): Promise<T> {
		const raw = await this.invokeRaw(operation, input);
		if (raw.exitCode !== 0) {
			throw new AdapterInvocationError(
				"ADAPTER_PROCESS_FAILED",
				`Adapter operation ${operation} exited ${raw.exitCode}: ${raw.stderr.trim()}`,
			);
		}
		let response: AdapterSuccess<T> | AdapterFailure;
		try {
			response = JSON.parse(raw.stdout) as AdapterSuccess<T> | AdapterFailure;
		} catch {
			throw new AdapterInvocationError(
				"ADAPTER_PROTOCOL_INVALID",
				`Adapter operation ${operation} returned invalid JSON: ${raw.stdout}`,
			);
		}
		if (!response.ok) throw new AdapterInvocationError(response.error.code, response.error.message);
		return response.result;
	}
}
