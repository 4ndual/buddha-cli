import * as fs from "node:fs/promises";
import * as path from "node:path";

async function readTrimmed(filePath: string): Promise<string | null> {
	try {
		return (await Bun.file(filePath).text()).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function gitHeadCommit(worktreeRoot: string): Promise<string | null> {
	const dotGit = path.join(worktreeRoot, ".git");
	const dotGitStat = await fs.stat(dotGit);
	let gitDirectory = dotGit;
	if (dotGitStat.isFile()) {
		const pointer = await readTrimmed(dotGit);
		if (!pointer?.startsWith("gitdir: ")) return null;
		gitDirectory = path.resolve(worktreeRoot, pointer.slice("gitdir: ".length));
	}
	const head = await readTrimmed(path.join(gitDirectory, "HEAD"));
	if (!head) return null;
	if (/^[a-f0-9]{40}$/i.test(head)) return head;
	if (!head.startsWith("ref: ")) return null;
	const reference = head.slice("ref: ".length);
	const localReference = await readTrimmed(path.join(gitDirectory, reference));
	if (localReference && /^[a-f0-9]{40}$/i.test(localReference)) return localReference;
	const commonPointer = await readTrimmed(path.join(gitDirectory, "commondir"));
	const commonDirectory = commonPointer ? path.resolve(gitDirectory, commonPointer) : gitDirectory;
	const commonReference = await readTrimmed(path.join(commonDirectory, reference));
	if (commonReference && /^[a-f0-9]{40}$/i.test(commonReference)) return commonReference;
	const packed = await readTrimmed(path.join(commonDirectory, "packed-refs"));
	if (!packed) return null;
	for (const line of packed.split("\n")) {
		const [commit, name] = line.split(" ");
		if (name === reference && /^[a-f0-9]{40}$/i.test(commit)) return commit;
	}
	return null;
}
