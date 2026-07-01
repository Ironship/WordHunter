const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const webJsRoot = path.join(repoRoot, "src", "web", "js");

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [fullPath] : [];
  });
}

function staticImports(source) {
  const imports = [];
  const patterns = [
    /\bimport\s+(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"'()]+?\s+from\s+["']([^"']+)["']/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) imports.push(match[1]);
  }
  return imports;
}

test("relative web module imports resolve to existing files", () => {
  const missing = [];
  for (const file of walk(webJsRoot)) {
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of staticImports(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(target)) {
        missing.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
