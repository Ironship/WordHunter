import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDir = join(root, "src", "web");
const outputDir = join(root, "dist", "web");
const temporaryDir = join(root, "dist", `.web-build-${process.pid}`);
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");

await rm(temporaryDir, { recursive: true, force: true });
await mkdir(temporaryDir, { recursive: true });

const compile = spawnSync(process.execPath, [
  tscBin,
  "--project",
  join(root, "tsconfig.json"),
  "--outDir",
  temporaryDir
], {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
});
if (compile.error) throw compile.error;
if (compile.status !== 0) {
  await rm(temporaryDir, { recursive: true, force: true });
  process.exit(compile.status ?? 1);
}

async function copyAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(directory, entry.name);
    if (entry.isDirectory()) {
      await copyAssets(source);
      continue;
    }
    if (extname(entry.name) === ".ts") continue;
    const destination = join(temporaryDir, relative(sourceDir, source));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
}

await copyAssets(sourceDir);

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }
  return files;
}

const buildInputs = [
  ...await collectFiles(sourceDir),
  join(root, "tsconfig.json"),
  join(root, "package-lock.json"),
  fileURLToPath(import.meta.url)
].sort((left, right) => {
  const leftPath = relative(root, left).replaceAll("\\", "/");
  const rightPath = relative(root, right).replaceAll("\\", "/");
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
});
const hash = createHash("sha256");
for (const file of buildInputs) {
  hash.update(relative(root, file).replaceAll("\\", "/"));
  hash.update("\0");
  hash.update(await readFile(file));
  hash.update("\0");
}
await writeFile(join(temporaryDir, ".wordhunter-build.sha256"), `${hash.digest("hex")}\n`);

await rm(outputDir, { recursive: true, force: true });
await rename(temporaryDir, outputDir);
