import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface DurableFileStat {
	isFile: boolean;
	isDirectory: boolean;
	size: number;
	device: number;
}

export interface DurableIo {
	mkdir(directory: string): Promise<void>;
	writeFile(filePath: string, content: Uint8Array | string): Promise<void>;
	readFile(filePath: string): Promise<Uint8Array>;
	readText(filePath: string): Promise<string>;
	rename(source: string, destination: string): Promise<void>;
	remove(target: string, recursive?: boolean): Promise<void>;
	list(directory: string): Promise<string[]>;
	stat(target: string): Promise<DurableFileStat>;
	fsyncDirectory(directory: string): Promise<void>;
}

async function writeFileFully(filePath: string, content: Uint8Array | string): Promise<void> {
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	const handle = await fs.open(filePath, "wx", 0o600);
	try {
		let offset = 0;
		while (offset < bytes.byteLength) {
			const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
			if (bytesWritten <= 0) throw new Error(`Short write while persisting ${filePath}`);
			offset += bytesWritten;
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export const durableIo: DurableIo = {
	async mkdir(directory) {
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	},
	writeFile: writeFileFully,
	async readFile(filePath) {
		return fs.readFile(filePath);
	},
	async readText(filePath) {
		return Bun.file(filePath).text();
	},
	async rename(source, destination) {
		await fs.rename(source, destination);
	},
	async remove(target, recursive = false) {
		await fs.rm(target, { recursive, force: true });
	},
	async list(directory) {
		return fs.readdir(directory);
	},
	async stat(target) {
		const result = await fs.stat(target);
		return {
			isFile: result.isFile(),
			isDirectory: result.isDirectory(),
			size: result.size,
			device: result.dev,
		};
	},
	async fsyncDirectory(directory) {
		const handle = await fs.open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	},
};

export async function writeJsonAtomicDurable(
	filePath: string,
	value: unknown,
	io: DurableIo = durableIo,
): Promise<void> {
	const directory = path.dirname(filePath);
	await io.mkdir(directory);
	const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
	try {
		await io.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
		await io.rename(temporaryPath, filePath);
		await io.fsyncDirectory(directory);
	} finally {
		await io.remove(temporaryPath).catch(() => undefined);
	}
}

export async function pathExists(target: string, io: DurableIo = durableIo): Promise<boolean> {
	try {
		await io.stat(target);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
