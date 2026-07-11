import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSimpleYaml } from "../../scripts/inspect-artifact.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

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
    assert.ok(!commands.some((command) => command.startsWith("run_optional cargo clippy")));
  });

  it("parses CI policy and keeps expensive release packaging out of the PR workflow", () => {
    const workflow = parseSimpleYaml(read("../../.github/workflows/validate.yml"));
    const validate = workflow.jobs.validate;
    const android = workflow.jobs["android-debug"];

    assert.equal(workflow.permissions.contents, "read");
    assertActionsArePinned(workflow);
    assert.ok(workflow.on.pull_request !== undefined);
    assert.deepEqual(workflow.on.push.branches, ["main", "feat/**"]);
    assert.equal(validate["runs-on"], "ubuntu-24.04");
    assert.equal(validate.env.WORDHUNTER_VALIDATE_CLIPPY, "1");
    assert.equal(validate.env.WORDHUNTER_VALIDATE_LICENSES, "1");
    assert.equal(stepByName(validate, "Set up Node").with["node-version"], "22");
    assert.equal(stepByName(validate, "Set up Rust").with.toolchain, "1.88");
    assert.equal(stepByName(validate, "Set up Rust").with.components, "rustfmt, clippy");
    assert.equal(
      stepByName(validate, "Install pinned cargo-about").run,
      "cargo install cargo-about --version 0.9.1 --locked --features cli",
    );
    assert.equal(stepByName(validate, "Validate").run, "./scripts/validate.sh");

    assert.equal(android["runs-on"], "windows-2022");
    assert.equal(stepByName(android, "Set up Rust").with.targets, "aarch64-linux-android");
    assert.equal(stepByName(android, "Build Android debug APK through the release recipe").run, "scripts\\build.bat apk");
    assert.match(stepByName(android, "Inspect Android debug APK").run, /inspect-artifact\.mjs android/);
    const prCommands = validate.steps.map((step) => step.run ?? "").join("\n");
    assert.doesNotMatch(prCommands, /build-flatpak|build\.bat all|tauri build/);
  });

  it("parses the release/nightly artifact matrix and requires each artifact", () => {
    const workflow = parseSimpleYaml(read("../../.github/workflows/artifact-validation.yml"));

    assert.ok(workflow.on.schedule[0].cron);
    assertActionsArePinned(workflow);
    assert.deepEqual(workflow.on.release.types, ["published"]);
    assert.ok(workflow.on.workflow_dispatch !== undefined);
    assert.deepEqual(Object.keys(workflow.jobs).sort(), ["android", "flatpak", "windows"]);
    assert.match(stepByName(workflow.jobs.android, "Build APK and AAB through the release recipe").run, /build\.bat apk aab/);
    assert.match(stepByName(workflow.jobs.android, "Inspect APK and AAB").run, /\.apk --abi arm64-v8a/);
    assert.match(stepByName(workflow.jobs.android, "Inspect APK and AAB").run, /\.aab --abi arm64-v8a/);
    assert.match(stepByName(workflow.jobs.windows, "Build Windows release packages").run, /build\.bat all/);
    assert.match(stepByName(workflow.jobs.windows, "Inspect Windows release packages").run, /windows-portable/);
    assert.match(stepByName(workflow.jobs.windows, "Inspect Windows release packages").run, /windows-nsis/);
    assert.equal(stepByName(workflow.jobs.flatpak, "Build and inspect Flatpak bundle").run, "./scripts/build-flatpak.sh");
    for (const job of Object.values(workflow.jobs)) {
      const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
      assert.ok(upload, `${job.name} does not upload its validated artifact`);
      assert.equal(upload.with["if-no-files-found"], "error");
    }
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
