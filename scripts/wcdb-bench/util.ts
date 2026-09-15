import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Distribution, FileSizes, MemorySnapshot, ResourceDelta } from "./types";

const textDecoder = new TextDecoder();

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(",")}}`;
}

export function sha256Text(value: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return hasher.digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	const stream = Bun.file(filePath).stream();
	for await (const chunk of stream) hasher.update(chunk);
	return hasher.digest("hex");
}

export function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = values.toSorted((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index];
}

export function distribution(values: number[]): Distribution {
	const total = values.reduce((sum, value) => sum + value, 0);
	return {
		iterations: values.length,
		minMs: percentile(values, 0),
		p50Ms: percentile(values, 0.5),
		p95Ms: percentile(values, 0.95),
		p99Ms: percentile(values, 0.99),
		maxMs: percentile(values, 1),
		meanMs: values.length === 0 ? 0 : total / values.length,
	};
}

function parseKbValue(text: string, key: string): number | null {
	const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
	return match ? Number(match[1]) * 1024 : null;
}

export async function memorySnapshot(): Promise<MemorySnapshot> {
	const usage = process.memoryUsage();
	let pssBytes: number | null = null;
	let privateBytes: number | null = null;
	let osMemAvailableBytes: number | null = null;
	let peakRssBytes: number | null = null;
	let osMemFreeBytes: number | null = null;
	let osCachedBytes: number | null = null;
	try {
		const smaps = await Bun.file("/proc/self/smaps_rollup").text();
		pssBytes = parseKbValue(smaps, "Pss");
		const privateClean = parseKbValue(smaps, "Private_Clean") ?? 0;
		const privateDirty = parseKbValue(smaps, "Private_Dirty") ?? 0;
		privateBytes = privateClean + privateDirty;
	} catch {
		// Linux-only detail remains null on unavailable procfs.
	}
	try {
		const status = await Bun.file("/proc/self/status").text();
		peakRssBytes = parseKbValue(status, "VmHWM");
	} catch {
		// Linux-only high-water RSS remains null on unavailable procfs.
	}
	try {
		const meminfo = await Bun.file("/proc/meminfo").text();
		osMemAvailableBytes = parseKbValue(meminfo, "MemAvailable");
		osMemFreeBytes = parseKbValue(meminfo, "MemFree");
		osCachedBytes = parseKbValue(meminfo, "Cached");
	} catch {
		// Linux-only detail remains null on unavailable procfs.
	}
	return {
		rssBytes: usage.rss,
		peakRssBytes,
		pssBytes,
		privateBytes,
		bunHeapUsedBytes: usage.heapUsed,
		bunHeapTotalBytes: usage.heapTotal,
		externalBytes: usage.external,
		osMemAvailableBytes,
		osMemFreeBytes,
		osCachedBytes,
	};
}

export async function measureResources<T>(operation: () => T | Promise<T>): Promise<{ value: T; elapsedMs: number; resources: ResourceDelta }> {
	const beforeMemory = await memorySnapshot();
	const beforeCpu = process.cpuUsage();
	const started = Bun.nanoseconds();
	const value = await operation();
	const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
	const cpu = process.cpuUsage(beforeCpu);
	const afterMemory = await memorySnapshot();
	return {
		value,
		elapsedMs,
		resources: {
			cpuUserMicros: cpu.user,
			cpuSystemMicros: cpu.system,
			maxRssBytes: Math.max(beforeMemory.peakRssBytes ?? beforeMemory.rssBytes, afterMemory.peakRssBytes ?? afterMemory.rssBytes),
			peakPssBytes:
				beforeMemory.pssBytes === null && afterMemory.pssBytes === null
					? null
					: Math.max(beforeMemory.pssBytes ?? 0, afterMemory.pssBytes ?? 0),
			before: beforeMemory,
			after: afterMemory,
		},
	};
}

async function sizeOrZero(filePath: string): Promise<number> {
	try {
		return (await fs.stat(filePath)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

export async function databaseFileSizes(databasePath: string, pageSize?: number, pageCount?: number, freePages?: number, indexBytes?: number | null): Promise<FileSizes> {
	const databaseBytes = await sizeOrZero(databasePath);
	const walBytes = await sizeOrZero(`${databasePath}-wal`);
	const shmBytes = await sizeOrZero(`${databasePath}-shm`);
	return {
		databaseBytes,
		walBytes,
		shmBytes,
		totalBytes: databaseBytes + walBytes + shmBytes,
		pageBytes: pageSize !== undefined && pageCount !== undefined ? pageSize * pageCount : null,
		freelistBytes: pageSize !== undefined && freePages !== undefined ? pageSize * freePages : null,
		indexBytes: indexBytes ?? null,
	};
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.tmp-${process.pid}`;
	await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
	const handle = await fs.open(temporary, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, filePath);
	const directory = await fs.open(path.dirname(filePath), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const handle = await fs.open(filePath, "a");
	try {
		await handle.write(`${JSON.stringify(value)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function machineDetails(targetPath: string): Promise<{
	hostname: string;
	platform: string;
	arch: string;
	kernel: string;
	cpuModel: string;
	logicalCpus: number;
	filesystem: string;
	mountOptions: string;
	bunVersion: string;
}> {
	let filesystem = "unknown";
	let mountOptions = "unknown";
	try {
		const realTarget = await fs.realpath(targetPath);
		const mounts = (await Bun.file("/proc/mounts").text())
			.trim()
			.split("\n")
			.map(line => line.split(" "))
			.filter(parts => parts.length >= 4 && (realTarget === parts[1] || realTarget.startsWith(`${parts[1].replace(/\/$/, "")}/`)))
			.toSorted((a, b) => b[1].length - a[1].length);
		if (mounts[0]) {
			filesystem = mounts[0][2];
			mountOptions = mounts[0][3];
		}
	} catch {
		// Receipt explicitly records unknown if mount metadata is unavailable.
	}
	const cpus = os.cpus();
	return {
		hostname: os.hostname(),
		platform: process.platform,
		arch: process.arch,
		kernel: os.release(),
		cpuModel: cpus[0]?.model ?? "unknown",
		logicalCpus: cpus.length,
		filesystem,
		mountOptions,
		bunVersion: Bun.version,
	};
}

export async function readLinesWithBytes(filePath: string): Promise<Array<{ text: string; bytes: number; line: number }>> {
	const result: Array<{ text: string; bytes: number; line: number }> = [];
	const decoder = new TextDecoder();
	let pending = "";
	let lineNumber = 0;
	for await (const chunk of Bun.file(filePath).stream()) {
		pending += decoder.decode(chunk, { stream: true });
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const text = pending.slice(0, newline).replace(/\r$/, "");
			lineNumber++;
			result.push({ text, bytes: new TextEncoder().encode(`${text}\n`).byteLength, line: lineNumber });
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
	}
	pending += decoder.decode();
	if (pending.length > 0) result.push({ text: pending, bytes: new TextEncoder().encode(pending).byteLength, line: ++lineNumber });
	return result;
}

export async function streamTextLines(filePath: string, visit: (text: string, line: number, bytes: number) => void | Promise<void>): Promise<void> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let pending = "";
	let line = 0;
	for await (const chunk of Bun.file(filePath).stream()) {
		pending += decoder.decode(chunk, { stream: true });
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const text = pending.slice(0, newline).replace(/\r$/, "");
			await visit(text, ++line, encoder.encode(`${text}\n`).byteLength);
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
	}
	pending += decoder.decode();
	if (pending.length > 0) await visit(pending, ++line, encoder.encode(pending).byteLength);
}

export async function fsyncLatency(directory: string, iterations: number): Promise<number[]> {
	await fs.mkdir(directory, { recursive: true });
	const values: number[] = [];
	for (let index = 0; index < iterations; index++) {
		const filePath = path.join(directory, `.fsync-probe-${process.pid}-${index}`);
		const handle = await fs.open(filePath, "w");
		try {
			await handle.write(textDecoder.decode(new Uint8Array(4096)));
			const started = Bun.nanoseconds();
			await handle.sync();
			values.push((Bun.nanoseconds() - started) / 1_000_000);
		} finally {
			await handle.close();
			await fs.unlink(filePath);
		}
	}
	return values;
}
