#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
process.chdir(root);

function repositoryJsonFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.json"],
    { encoding: "buffer" }
  );
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => existsSync(file))
    .sort();
}

const parsed = new Map();
for (const file of repositoryJsonFiles()) {
  try {
    parsed.set(file, JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
}

const localeDir = path.join("src", "web", "i18n");
const localeFiles = readdirSync(localeDir).filter((name) => name.endsWith(".json")).sort();
assert.ok(localeFiles.includes("en.json"), "src/web/i18n/en.json is required as the i18n baseline");

for (const file of localeFiles) {
  const relativePath = path.join(localeDir, file);
  const data = parsed.get(relativePath) ?? JSON.parse(readFileSync(relativePath, "utf8"));
  assert.equal(Array.isArray(data), false, `${relativePath} must be a JSON object`);
  assert.equal(typeof data, "object", `${relativePath} must be a JSON object`);
  assert.ok(Object.keys(data).length > 0, `${relativePath} must not be empty`);
}

console.log(`Validated ${parsed.size} repository JSON files and ${localeFiles.length} i18n locales.`);
