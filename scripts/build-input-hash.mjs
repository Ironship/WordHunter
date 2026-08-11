// Shared frontend build-input hashing.
//
// build-frontend.mjs stamps dist/web/.wordhunter-build.sha256 from these
// inputs; frontend tests that read generated assets recompute the same digest
// so a direct test run fails loudly when dist/web is stale relative to
// src/web (see #119). Keep the input set and byte layout identical between
// the build and the guard, or the freshness check becomes vacuous.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDir = join(root, "src", "web");

export async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }
  return files;
}

export async function buildInputFiles() {
  return [
    ...await collectFiles(sourceDir),
    join(root, "tsconfig.json"),
    join(root, "package.json"),
    join(root, "package-lock.json"),
    join(root, "scripts", "build-frontend.mjs"),
    fileURLToPath(import.meta.url)
  ].sort((left, right) => {
    const leftPath = relative(root, left).replaceAll("\\", "/");
    const rightPath = relative(root, right).replaceAll("\\", "/");
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
}

export async function computeBuildInputHash() {
  const hash = createHash("sha256");
  for (const file of await buildInputFiles()) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
