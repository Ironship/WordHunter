import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseSimpleYaml } from "../../scripts/inspect-artifact.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    return entry.isDirectory() ? filesBelow(child) : [child];
  });
}

function activeShellLines(source) {
  const lines = [];
  let pending = "";
  for (const raw of source.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    pending += `${pending ? " " : ""}${trimmed.replace(/\\$/, "").trimEnd()}`;
    if (!trimmed.endsWith("\\")) {
      lines.push(pending);
      pending = "";
    }
  }
  if (pending) lines.push(pending);
  return lines;
}

function stepByName(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `workflow job is missing step: ${name}`);
  return step;
}

function assertActionsArePinned(workflow) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (!step.uses) continue;
      assert.match(step.uses, /^[^@]+@[0-9a-f]{40}$/, `action is not commit-pinned: ${step.uses}`);
    }
  }
}

describe("repository validation wiring", () => {
  it("runs required validation commands rather than matching comments", () => {
    const commands = activeShellLines(read("../../scripts/validate.sh"));

    for (const command of [
      "run git diff --check",
      "run node scripts/validate-json-i18n.mjs",
      "run npm run check:frontend",
      "run node --experimental-vm-modules --test frontend-tests/shared/*.test.js frontend-tests/desktop/*.test.js frontend-tests/android/*.test.js",
      "run ./scripts/update-flatpak-cargo-sources.sh --check",
      "run ./scripts/update-third-party-licenses.sh --check",
      "run cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check",
      "run cargo fmt --manifest-path src-tauri/ocr-runner/Cargo.toml --all -- --check",
      "run cargo test --locked --manifest-path src-tauri/Cargo.toml",
      "run cargo test --locked --manifest-path src-tauri/ocr-runner/Cargo.toml",
      "run cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets",
      "run cargo clippy --locked --manifest-path src-tauri/ocr-runner/Cargo.toml --all-targets",
    ]) {
      assert.ok(commands.includes(command), `validator does not execute: ${command}`);
    }
    assert.ok(commands.some((command) => command.includes('WORDHUNTER_VALIDATE_CLIPPY:-1')));
    assert.ok(commands.some((command) => command.includes('WORDHUNTER_VALIDATE_LICENSES:-1')));
    assert.ok(commands.some((command) => command.includes('git diff --check "$diff_base"..HEAD')));
    assert.ok(!commands.some((command) => command.startsWith("run_optional cargo clippy")));
  });

  it("parses CI policy and keeps expensive release packaging out of the PR workflow", () => {
    const workflow = parseSimpleYaml(read("../../.github/workflows/validate.yml"));
    const validate = workflow.jobs.validate;
    const android = workflow.jobs["android-debug"];

    assert.equal(workflow.permissions.contents, "read");
    assertActionsArePinned(workflow);
    assert.ok(workflow.on.pull_request !== undefined);
    assert.deepEqual(workflow.on.push.branches, ["main", "feat/**", "release/**"]);
    assert.equal(validate["runs-on"], "ubuntu-24.04");
    assert.equal(validate.env.WORDHUNTER_VALIDATE_CLIPPY, "1");
    assert.equal(validate.env.WORDHUNTER_VALIDATE_LICENSES, "1");
    assert.match(validate.env.WORDHUNTER_DIFF_BASE, /github\.event/);
    assert.equal(stepByName(validate, "Checkout").with["fetch-depth"], 0);
    const nodeSetup = stepByName(validate, "Set up Node");
    assert.equal(nodeSetup.with["node-version"], "22");
    assert.equal(nodeSetup.with.cache, "npm");
    assert.equal(
      stepByName(validate, "Install frontend validation dependencies").run,
      "npm ci --ignore-scripts --no-audit --no-fund",
    );
    const rustSetup = stepByName(validate, "Set up Rust");
    assert.equal(rustSetup.uses, "dtolnay/rust-toolchain@4e529fb27e59237866a6523e61ab248308c068b4");
    assert.equal(rustSetup.with.toolchain, undefined);
    assert.equal(rustSetup.with.components, "rustfmt, clippy");
    assert.equal(
      stepByName(validate, "Install pinned cargo-about").run,
      "cargo install cargo-about --version 0.9.1 --locked --features cli",
    );
    assert.equal(stepByName(validate, "Validate repository (build frontend before tests)").run, "./scripts/validate.sh");

    assert.equal(android["runs-on"], "windows-2022");
    assert.equal(stepByName(android, "Set up Rust").with.targets, "aarch64-linux-android");
    assert.equal(stepByName(android, "Build frontend and Android debug APK through the release recipe").run, "scripts\\build.bat apk");
    assert.match(stepByName(android, "Inspect Android debug APK").run, /inspect-artifact\.mjs android/);
    const prCommands = validate.steps.map((step) => step.run ?? "").join("\n");
    assert.doesNotMatch(prCommands, /build-flatpak|build\.bat all|tauri build/);
  });

  it("parses the release/nightly artifact matrix and requires each artifact", () => {
    const workflow = parseSimpleYaml(read("../../.github/workflows/artifact-validation.yml"));

    assert.ok(workflow.on.schedule[0].cron);
    assertActionsArePinned(workflow);
    assert.equal(workflow.permissions.contents, "read");
    assert.equal(workflow.on.release, undefined);
    assert.ok(workflow.on.workflow_dispatch !== undefined);
    assert.deepEqual(Object.keys(workflow.jobs).sort(), ["android", "flatpak", "frontend-validation", "publish-release", "release-preflight", "windows"]);
    const releasePreflight = workflow.jobs["release-preflight"];
    const frontendValidation = workflow.jobs["frontend-validation"];
    const revisionCheck = stepByName(releasePreflight, "Match a requested draft release to this revision");
    assert.match(releasePreflight.if, /workflow_dispatch[\s\S]*release_tag/);
    assert.equal(revisionCheck.env.GH_REPO, "${{ github.repository }}");
    assert.match(revisionCheck.run, /isDraft,targetCommitish[\s\S]*repos\/\$GH_REPO\/commits\/\$RELEASE_TAG[\s\S]*repos\/\$GH_REPO\/commits\/\$release_target[\s\S]*test "\$target_sha" = "\$GITHUB_SHA"/);
    assert.equal(releasePreflight.permissions.contents, "write");
    assert.equal(frontendValidation.needs, "release-preflight");
    assert.match(frontendValidation.if, /!cancelled\(\)[\s\S]*success[\s\S]*skipped/);
    assert.equal(stepByName(frontendValidation, "Set up Node").with.cache, "npm");
    assert.equal(
      stepByName(frontendValidation, "Install frontend validation dependencies").run,
      "npm ci --ignore-scripts --no-audit --no-fund",
    );
    assert.equal(stepByName(frontendValidation, "Build and validate frontend sources").run, "npm run check:frontend");
    assert.match(stepByName(frontendValidation, "Validate frontend behavior and repository data").run, /validate-json-i18n[\s\S]*--test/);
    assert.match(stepByName(workflow.jobs.android, "Build frontend, APK, and AAB through the release recipe").run, /build\.bat apk aab/);
    assert.match(stepByName(workflow.jobs.android, "Inspect APK and AAB").run, /\.apk --abi arm64-v8a/);
    assert.match(stepByName(workflow.jobs.android, "Inspect APK and AAB").run, /\.aab --abi arm64-v8a/);
    assert.match(stepByName(workflow.jobs.windows, "Build frontend and Windows release packages").run, /build\.bat all/);
    assert.match(stepByName(workflow.jobs.windows, "Inspect Windows release packages").run, /windows-portable/);
    assert.match(stepByName(workflow.jobs.windows, "Inspect Windows release packages").run, /windows-nsis/);
    assert.equal(stepByName(workflow.jobs.flatpak, "Build frontend, then build and inspect Flatpak bundle").run, "./scripts/build-flatpak.sh");
    for (const name of ["android", "windows", "flatpak"]) {
      const job = workflow.jobs[name];
      assert.equal(job.needs, "frontend-validation");
      const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
      assert.ok(upload, `${job.name} does not upload its validated artifact`);
      assert.equal(upload.with["if-no-files-found"], "error");
    }
    const publish = workflow.jobs["publish-release"];
    assert.deepEqual(publish.needs, ["android", "windows", "flatpak"]);
    assert.equal(publish.permissions.contents, "write");
    assert.match(publish.if, /workflow_dispatch[\s\S]*release_tag/);
    const finalRevisionCheck = stepByName(publish, "Revalidate the draft release revision");
    assert.match(finalRevisionCheck.run, /isDraft,targetCommitish[\s\S]*repos\/\$GH_REPO\/commits\/\$RELEASE_TAG[\s\S]*repos\/\$GH_REPO\/commits\/\$release_target[\s\S]*test "\$target_sha" = "\$GITHUB_SHA"/);
    const download = stepByName(publish, "Download validated artifacts on the GitHub runner");
    assert.equal(download.uses, "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    assert.equal(download.with.pattern, "validated-*");
    assert.equal(download.with["merge-multiple"], true);
    assert.equal(finalRevisionCheck.env.GH_REPO, "${{ github.repository }}");
    const attach = stepByName(publish, "Attach validated assets to the draft release");
    assert.equal(attach.env.GH_REPO, "${{ github.repository }}");
    assert.match(attach.run, /gh release upload[\s\S]*--clobber/);
  });

  it("keeps the TypeScript build pinned, explicit, and outside source assets", () => {
    const packageJson = JSON.parse(read("../../package.json"));
    const lockfile = JSON.parse(read("../../package-lock.json"));
    const tsconfig = JSON.parse(read("../../tsconfig.json"));
    const stylelint = read("../../stylelint.config.mjs");
    const gitignore = read("../../.gitignore");
    const flatpak = parseSimpleYaml(read("../../com.wordhunter.app.yml"));

    assert.equal(packageJson.private, true);
    assert.equal(packageJson.type, "module");
    assert.deepEqual(lockfile.packages[""].devDependencies, packageJson.devDependencies);
    assert.equal(lockfile.lockfileVersion, 3);
    for (const version of Object.values(packageJson.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(tsconfig.compilerOptions.rootDir, "src/web");
    assert.equal(tsconfig.compilerOptions.outDir, "dist/web");
    assert.equal(tsconfig.compilerOptions.noEmitOnError, true);
    assert.equal(tsconfig.compilerOptions.strict, true);
    assert.equal(tsconfig.compilerOptions.noImplicitAny, true);
    assert.equal(tsconfig.compilerOptions.strictNullChecks, false);
    assert.ok(tsconfig.include.includes("src/web/**/*.ts"));
    assert.equal(packageJson.scripts["build:frontend"], "node scripts/build-frontend.mjs");
    assert.equal(packageJson.scripts["check:ts"], "tsc --project tsconfig.json --noEmit");
    for (const suite of ["frontend", "shared", "desktop", "android"]) {
      const command = packageJson.scripts[`test:${suite}`];
      assert.match(command, /^npm run build:frontend && node --experimental-vm-modules --test /);
    }
    assert.match(packageJson.scripts["test:frontend"], /frontend-tests\/shared\/\*\.test\.js/);
    assert.match(packageJson.scripts["test:frontend"], /frontend-tests\/desktop\/\*\.test\.js/);
    assert.match(packageJson.scripts["test:frontend"], /frontend-tests\/android\/\*\.test\.js/);
    assert.doesNotMatch(packageJson.scripts["check:frontend"], /--fix|postcss|sass/);
    assert.doesNotMatch(packageJson.scripts["lint:css"], /--fix|--cache|--output-file/);
    assert.match(stylelint, /postcss-html/);
    assert.match(gitignore, /^node_modules\/$/m);
    const source = flatpak.modules[0].sources.find((item) => item.type === "dir");
    assert.ok(source.skip.includes("node_modules"));
  });

  it("ships only compiled JavaScript and rejects stale native frontend builds", () => {
    const sourceFiles = filesBelow(new URL("../../src/web/", import.meta.url));
    const outputFiles = filesBelow(new URL("../../dist/web/", import.meta.url));
    const buildScript = read("../../scripts/build-frontend.mjs");
    const rustBuild = read("../../src-tauri/build.rs");
    const sourceModules = sourceFiles.filter((file) => file.pathname.endsWith(".ts"));
    const outputModules = outputFiles.filter((file) => file.pathname.endsWith(".js"));

    assert.ok(sourceModules.length > 0);
    assert.equal(sourceFiles.filter((file) => file.pathname.endsWith(".js")).length, 0);
    assert.equal(outputModules.length, sourceModules.length);
    assert.equal(outputFiles.filter((file) => file.pathname.endsWith(".ts")).length, 0);
    for (const html of [read("../../src/web/index.html"), read("../../src/web/templates/translator-popup.html")]) {
      assert.doesNotMatch(html, /<script>[^]*?<\/script>/i);
      assert.doesNotMatch(html, /\son[a-z]+=/i);
    }
    assert.match(read("../../dist/web/.wordhunter-build.sha256"), /^[0-9a-f]{64}\s*$/);
    assert.match(buildScript, /\.web-build-\$\{process\.pid\}/);
    assert.match(buildScript, /await rename\(temporaryDir, outputDir\)/);
    assert.match(rustBuild, /compiled frontend is stale/);
    assert.match(rustBuild, /frontend_source_hash/);
  });

  it("keeps reviewable docs tracked while generated runtime payloads stay ignored", () => {
    const gitignore = read("../../.gitignore");
    const docs = read("../../docs/release-validation.md");

    assert.doesNotMatch(gitignore, /^docs\/\*\.md$/m);
    assert.doesNotMatch(gitignore, /^docs\/\*\*\/\*\.md$/m);
    assert.doesNotMatch(gitignore, /^src-tauri\/ocr-runner\/Cargo\.lock$/m);
    assert.match(gitignore, /^src-tauri\/syncthing\/\*$/m);
    assert.match(gitignore, /^!src-tauri\/syncthing\/\.gitkeep$/m);
    assert.match(docs, /WORDHUNTER_VALIDATE_CLIPPY=0/);
    assert.match(docs, /artifact-validation\.yml/);
  });
});
