import * as path from "node:path";

interface NativeLock {
	wcdb: { release: string; archiveSha256: string };
	bundled: { sqliteVersion: string };
}

const [sourceRootArgument, archiveArgument, stagingRootArgument] = process.argv.slice(2);
if (!sourceRootArgument || !archiveArgument || !stagingRootArgument) {
	throw new Error("Usage: bun build.ts <extracted-wcdb-root> <source-archive> <team-native-staging-root>");
}

const sourceRoot = path.resolve(sourceRootArgument);
const archive = path.resolve(archiveArgument);
const stagingRoot = path.resolve(stagingRootArgument);
const allowedRoot = "/home/andual/Projects/.omp-wcdb-team/staging/native";
if (stagingRoot !== allowedRoot && !stagingRoot.startsWith(`${allowedRoot}/`)) {
	throw new Error(`Refusing native build output outside ${allowedRoot}`);
}

async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

const lock = (await Bun.file(path.join(import.meta.dir, "../wcdb.lock.json")).json()) as NativeLock;
const archiveHash = await sha256File(archive);
if (archiveHash !== lock.wcdb.archiveSha256) throw new Error(`WCDB source archive hash mismatch: ${archiveHash}`);
const version = (await Bun.file(path.join(sourceRoot, "VERSION")).text()).trim();
if (version !== lock.wcdb.release) throw new Error(`WCDB source version mismatch: ${version}`);
const sqliteHeader = await Bun.file(path.join(sourceRoot, "sqlcipher/sqlite3.h")).text();
if (!sqliteHeader.includes(`#define SQLITE_VERSION        "${lock.bundled.sqliteVersion}"`)) {
	throw new Error("WCDB bundled SQLite version does not match the lock manifest");
}

async function run(command: string[], cwd: string): Promise<void> {
	const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`${command.join(" ")} exited ${exitCode}`);
}

const wcdbBuild = path.join(stagingRoot, "build-static");
const bridgeBuild = path.join(stagingRoot, "bridge-build-static");
const installRoot = path.join(stagingRoot, "install-static");
await run([
	"cmake",
	"-S", path.join(sourceRoot, "src"),
	"-B", wcdbBuild,
	"-G", "Ninja",
	"-DCMAKE_BUILD_TYPE=Release",
	"-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
	"-DCMAKE_C_FLAGS=-D_Nullable= -D_Nonnull=",
	"-DCMAKE_CXX_FLAGS=-D_Nullable= -D_Nonnull= -include climits",
	"-DBUILD_SHARED_LIBS=OFF",
	"-DSKIP_WCONAN=ON",
	"-DWCDB_CPP=ON",
	"-DWCDB_BRIDGE=ON",
	"-DWCDB_ZSTD=ON",
], sourceRoot);
await run(["cmake", "--build", wcdbBuild, "--parallel", "1"], sourceRoot);
await run([
	"cmake",
	"-S", path.resolve(import.meta.dir, ".."),
	"-B", bridgeBuild,
	"-G", "Ninja",
	"-DCMAKE_BUILD_TYPE=Release",
	`-DWCDB_ROOT=${sourceRoot}`,
	`-DWCDB_BUILD=${wcdbBuild}`,
	`-DCMAKE_INSTALL_PREFIX=${installRoot}`,
], import.meta.dir);
await run(["cmake", "--build", bridgeBuild, "--parallel", "1"], import.meta.dir);
await run(["cmake", "--install", bridgeBuild], import.meta.dir);
process.stdout.write(`${path.join(installRoot, "lib/libomp_wcdb_bridge.so")}\n`);
