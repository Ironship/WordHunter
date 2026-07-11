const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { fileURLToPath, pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..", "..");
const webRoot = path.join(repoRoot, "src", "web");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [fullPath] : [];
  });
}

function dynamicImports(source) {
  return [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
}

test("the complete web module graph links", async () => {
  assert.equal(typeof vm.SourceTextModule, "function", "run Node with --experimental-vm-modules");
  const files = walk(webRoot);
  const modules = new Map(files.map((file) => {
    const normalized = path.normalize(file);
    return [normalized, new vm.SourceTextModule(fs.readFileSync(normalized, "utf8"), {
      identifier: pathToFileURL(normalized).href,
    })];
  }));
  const linker = (specifier, referencingModule) => {
      assert.ok(specifier.startsWith("."), `unexpected bare browser import: ${specifier}`);
      const target = path.normalize(fileURLToPath(new URL(specifier, referencingModule.identifier)));
      assert.ok(modules.has(target), `${referencingModule.identifier} -> ${specifier}`);
      return modules.get(target);
  };

  await modules.get(path.join(webRoot, "app.js")).link(linker);
  for (const module of modules.values()) {
    if (module.status === "unlinked") await module.link(linker);
  }
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of dynamicImports(source)) {
      assert.ok(specifier.startsWith("."), `unexpected bare dynamic import: ${specifier}`);
      const target = path.resolve(path.dirname(file), specifier);
      assert.ok(modules.has(path.normalize(target)), `${path.relative(repoRoot, file)} -> ${specifier}`);
    }
  }
});
