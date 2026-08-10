import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { collectFiles, computeBuildInputHash } from "./build-input-hash.mjs";

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

// boot.ts has no imports and must run synchronously before the first paint.
// TypeScript emits this marker because moduleDetection is forced for the rest
// of the frontend; remove only that marker so boot.js can be a classic script.
const bootOutput = join(temporaryDir, "boot.js");
const bootSource = await readFile(bootOutput, "utf8");
if (!/\r?\nexport \{\};\s*$/.test(bootSource)) {
  throw new Error("Unexpected boot.js module output");
}
await writeFile(bootOutput, bootSource.replace(/\r?\nexport \{\};\s*$/, "\n"));

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

const bundledApp = join(temporaryDir, "js", "app.bundle.js");
await build({
  entryPoints: [join(temporaryDir, "app.js")],
  outfile: bundledApp,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minifyIdentifiers: false,
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: "none",
  logLevel: "warning"
});

const indexOutput = join(temporaryDir, "index.html");
const indexSource = await readFile(indexOutput, "utf8");
const bundledIndex = indexSource.replace(
  '<script type="module" src="app.js"></script>',
  '<script type="module" src="js/app.bundle.js"></script>'
);
if (bundledIndex === indexSource) throw new Error("Could not select the bundled app entrypoint");
await writeFile(indexOutput, bundledIndex);

const digestHex = await computeBuildInputHash();
await writeFile(join(temporaryDir, ".wordhunter-build.sha256"), `${digestHex}\n`);

// Centralized cache-buster: every local HTML src/href and CSS url() receives
// the content hash. External URLs, fragments, and data URLs stay untouched.
const cacheBuster = digestHex.slice(0, 12);
function cacheVersionedUrl(url) {
  if (url.trim() === "" || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return url;
  const [withoutFragment, ...fragmentParts] = url.split("#");
  const fragment = fragmentParts.length > 0 ? `#${fragmentParts.join("#")}` : "";
  const versioned = /([?&])v=[^&#]*/.test(withoutFragment)
    ? withoutFragment.replace(/([?&])v=[^&#]*/, `$1v=${cacheBuster}`)
    : `${withoutFragment}${withoutFragment.includes("?") ? "&" : "?"}v=${cacheBuster}`;
  return `${versioned}${fragment}`;
}
for (const file of await collectFiles(temporaryDir)) {
  if (file.endsWith(".html")) {
    const html = await readFile(file, "utf8");
    const stamped = html.replace(/\b(src|href)="([^"]+)"/gi, (match, attribute, url) => (
      `${attribute}="${cacheVersionedUrl(url)}"`
    ));
    if (stamped !== html) await writeFile(file, stamped);
  } else if (file.endsWith(".css")) {
    const css = await readFile(file, "utf8");
    const stamped = css.replace(/url\((['"]?)([^'")]+)\1\)/gi, (match, quote, url) => (
      `url(${quote}${cacheVersionedUrl(url)}${quote})`
    ));
    if (stamped !== css) await writeFile(file, stamped);
  }
}

await rm(outputDir, { recursive: true, force: true });
await rename(temporaryDir, outputDir);
