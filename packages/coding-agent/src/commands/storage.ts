import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { storageHelp as commandHelp } from "../cli/command-help";
import { parseStorageCommand, processStorageReportSink, runStorageCommand } from "../storage/control/cli";
import { createStorageControlService } from "../storage/control/service";
import { STORAGE_ACTIONS } from "../storage/control/types";

export default class Storage extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Storage action",
			required: false,
			options: [...STORAGE_ACTIONS],
		}),
		mode: Args.string({
			description: "Target mode for the mode action",
			required: false,
			options: ["jsonl", "db"],
		}),
	};
	static flags = {
		"dry-run": Flags.boolean({ description: "Preview without committing changes", default: false }),
		"all-branches": Flags.boolean({ description: "Include every branch and sibling fork", default: false }),
		source: Flags.string({ description: "Explicit source path or archive" }),
		destination: Flags.string({ description: "Explicit destination path or archive" }),
		job: Flags.string({ description: "Transfer or recovery job id" }),
		report: Flags.string({ description: "Write the machine-readable report to this path" }),
		format: Flags.string({ description: "Machine report format", options: ["json", "jsonl"], default: "json" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Storage);
		const request = parseStorageCommand({
			action: args.action,
			mode: args.mode,
			dryRun: flags["dry-run"],
			allBranches: flags["all-branches"],
			source: flags.source,
			destination: flags.destination,
			jobId: flags.job,
			reportPath: flags.report,
			format: flags.format,
		});
		const report = await runStorageCommand(request, createStorageControlService(), processStorageReportSink);
		if (report.result.outcome === "blocked" || report.result.outcome === "failed") process.exitCode = 2;
	}
}
