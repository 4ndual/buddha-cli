import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { storageHelp as commandHelp } from "../cli/command-help";
import { parseStorageAction, parseStorageMode, runStorageCommand } from "../cli/storage";

export default class Storage extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "inventory | normalize | import | export | sync | verify | backup | recover | mode | status",
			required: false,
		}),
		value: Args.string({
			description: "Mode target for `mode`: jsonl | db",
			required: false,
		}),
	};

	static flags = {
		source: Flags.string({ description: "Explicit source path or repository selector" }),
		destination: Flags.string({ description: "Explicit destination path or repository selector" }),
		"allowed-root": Flags.string({ description: "Containment root for explicit recovery paths" }),
		fence: Flags.string({ description: "Persisted storage generation fence path" }),
		"dry-run": Flags.boolean({ description: "Preview without writes" }),
		"all-branches": Flags.boolean({ description: "Include every branch/fork" }),
		"job-id": Flags.string({ description: "Stable transfer job identifier" }),
		"expected-generation": Flags.integer({
			description: "Persisted storage generation required to fence repository mutations",
		}),
		"expected-nonce": Flags.string({ description: "Persisted storage generation nonce" }),
		"cancel-after-current-batch": Flags.boolean({
			description: "Request cancellation at the next durable batch boundary (requires --job-id)",
		}),
		resume: Flags.boolean({ description: "Resume an interrupted job (requires --job-id)" }),
		json: Flags.boolean({ description: "Emit the stable machine-readable report schema" }),
		machine: Flags.boolean({ description: "Emit the stable machine-readable report schema" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Storage);
		const action = parseStorageAction(args.action);
		if (!action) {
			process.stderr.write(`Unknown storage action: ${args.action ?? ""}\n`);
			process.exitCode = 1;
			return;
		}
		const report = await runStorageCommand({
			action,
			source: flags.source,
			destination: flags.destination,
			allowedRoot: flags["allowed-root"],
			fencePath: flags.fence,
			dryRun: flags["dry-run"],
			allBranches: flags["all-branches"],
			jobId: flags["job-id"],
			cancelAfterCurrentBatch: flags["cancel-after-current-batch"],
			resume: flags.resume,
			expectedGeneration: flags["expected-generation"],
			requestedMode: action === "mode" ? parseStorageMode(args.value) : undefined,
			machine: flags.json || flags.machine,
			expectedNonce: flags["expected-nonce"],
		});
		if (report.outcome === "failed" || report.outcome === "rejected") process.exitCode = 1;
	}
}
