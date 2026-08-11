import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  it("persists the derived AUR app version for every later workflow step", () => {
    const workflow = parseSimpleYaml(read("../../.github/workflows/aur-validation.yml"));
    const validate = workflow.jobs.validate;
    const versionStep = stepByName(validate, "Read app version");

    assert.match(versionStep.run, /tauri\.conf\.json/);
    assert.match(versionStep.run, /WH_APP_VERSION=.*GITHUB_ENV/);
    for (const name of ["Verify the pinned release source", "Validate package metadata and contents", "Install and smoke-test the package"]) {
      assert.match(stepByName(validate, name).run, /WH_APP_VERSION/);
    }
    const pinnedStep = stepByName(validate, "Verify the pinned release source");
    assert.match(pinnedStep.run, /\.SRCINFO/);
    assert.match(pinnedStep.run, /sha256sum/);
    assert.doesNotMatch(pinnedStep.run, /309dcae/);
  });

  it("parses the manually dispatched release matrix and requires each artifact", () => {
    const workflow = parseSimpleYaml(read("../../.github/workflows/artifact-validation.yml"));

    assert.equal(workflow.on.schedule, undefined);
    assertActionsArePinned(workflow);
    assert.equal(workflow.permissions.contents, "read");
    assert.equal(workflow.on.release, undefined);
    assert.ok(workflow.on.workflow_dispatch !== undefined);
    assert.deepEqual(Object.keys(workflow.jobs).sort(), [
      "android",
      "flatpak",
      "frontend-validation",
      "linux-native",
      "linux-native-runtime",
      "macos",
      "publish-release",
      "release-preflight",
      "windows",
    ]);
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
    const signingStep = stepByName(workflow.jobs.android, "Restore stable Android signing key");
    assert.equal(signingStep.env.KEYSTORE_BASE64, "${{ secrets.WH_ANDROID_KEYSTORE_BASE64 }}");
    assert.match(signingStep.run, /WH_ANDROID_REQUIRE_SIGNING=1/);
    assert.match(signingStep.run, /openssl pkcs12/);
    assert.match(signingStep.run, /WH_ANDROID_EXPECTED_CERT_SHA256=\$certSha/);
    assert.doesNotMatch(signingStep.run, /WH_ANDROID_EXPECTED_CERT_SHA256=b3b8336e/);
    assert.equal(workflow.jobs.macos["runs-on"], "macos-15");
    assert.match(stepByName(workflow.jobs.android, "Build frontend, APK, and AAB through the release recipe").run, /build\.bat apk aab/);
    assert.match(stepByName(workflow.jobs.android, "Inspect APK and AAB").run, /\.apk --abi arm64-v8a/);
    assert.match(stepByName(workflow.jobs.android, "Inspect APK and AAB").run, /\.aab --abi arm64-v8a/);
    assert.match(stepByName(workflow.jobs.windows, "Build frontend and Windows release packages").run, /build\.bat all/);
    assert.match(stepByName(workflow.jobs.windows, "Inspect Windows release packages").run, /windows-portable/);
    assert.match(stepByName(workflow.jobs.windows, "Inspect Windows release packages").run, /windows-nsis/);
    assert.equal(workflow.jobs.macos["runs-on"], "macos-15");
    assert.equal(
      stepByName(workflow.jobs.macos, "Build and smoke-test the Apple Silicon DMG").run,
      "./scripts/build-macos.sh",
    );
    assert.match(
      stepByName(workflow.jobs.macos, "Upload validated macOS DMG").with.path,
      /WordHunter-\$\{\{ steps\.package-version\.outputs\.version \}\}-aarch64\.dmg/,
    );
    assert.equal(stepByName(workflow.jobs.flatpak, "Build frontend, then build and inspect Flatpak bundle").run, "./scripts/build-flatpak.sh");
    assert.match(
      stepByName(workflow.jobs["linux-native"], "Build frontend, AppImage, and DEB through the release recipe").run,
      /build-linux-native\.sh/,
    );
    assert.match(workflow.jobs["linux-native"].if, /frontend-validation\.result == 'success'/);
    for (const name of ["android", "windows", "macos", "flatpak", "linux-native"]) {
      const job = workflow.jobs[name];
      assert.equal(job.needs, "frontend-validation");
      assert.match(job.if, /frontend-validation\.result == 'success'/);
      const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
      assert.ok(upload, `${job.name} does not upload its validated artifact`);
      assert.equal(upload.with["if-no-files-found"], "error");
    }
    const linuxRuntime = workflow.jobs["linux-native-runtime"];
    assert.equal(linuxRuntime.needs, "linux-native");
    assert.match(linuxRuntime.if, /linux-native\.result == 'success'/);
    assert.equal(linuxRuntime.container, "ubuntu:22.04");
    const linuxRuntimeInstall = stepByName(
      linuxRuntime,
      "Install AppImage host baseline and runtime test tools",
    ).run;
    for (const hostLibrary of [
      "libegl1",
      "libfontconfig1",
      "libfribidi0",
      "libgbm1",
      "libgles2",
      "libharfbuzz0b",
    ]) {
      assert.match(linuxRuntimeInstall, new RegExp(`\\b${hostLibrary}\\b`));
    }
    assert.doesNotMatch(linuxRuntimeInstall, /libgtk-3-0|libwebkit2gtk-4\.1-0|gstreamer1\.0-plugins/);
    assert.equal(
      stepByName(linuxRuntime, "Download validated Linux native packages").with.name,
      "validated-linux-native",
    );
    assert.match(
      stepByName(linuxRuntime, "Validate and smoke-test the self-contained AppImage").run,
      /appstreamcli validate[\s\S]*wordhunter-paddleocr[\s\S]*xvfb-run/,
    );
    assert.match(
      stepByName(linuxRuntime, "Validate, install, smoke-test, and remove the DEB").run,
      /lintian[\s\S]*apt-get install[\s\S]*xvfb-run[\s\S]*apt-get remove/,
    );
    const publish = workflow.jobs["publish-release"];
    assert.deepEqual(publish.needs, ["android", "windows", "macos", "flatpak", "linux-native", "linux-native-runtime"]);
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

  it("keeps the macOS package native, ad-hoc signed, and artifact-validated", () => {
    const config = JSON.parse(read("../../src-tauri/tauri.macos.conf.json"));
    const buildScript = read("../../scripts/build-macos.sh");
    const platform = read("../../src-tauri/src/platform/mod.rs");

    assert.deepEqual(config.bundle.targets, ["dmg"]);
    assert.equal(config.bundle.licenseFile, "../LICENSE");
    assert.equal(config.bundle.macOS.signingIdentity, "-");
    assert.equal(config.bundle.macOS.minimumSystemVersion, "11.0");
    assert.match(platform, /target_os = "macos"/);
    assert.match(buildScript, /--target aarch64-apple-darwin/);
    assert.match(buildScript, /hdiutil verify/);
    assert.match(buildScript, /for attempt in 1 2 3/);
    assert.match(buildScript, /hdiutil attach -mountrandom \/tmp -readonly -noverify -noautoopen -nobrowse/);
    assert.match(buildScript, /hdiutil detach "\$device"/);
    assert.match(buildScript, /codesign --verify --deep --strict/);
    assert.match(buildScript, /kill -0 "\$app_pid"/);
    assert.match(buildScript, /release_version="\$\{package_version\/\+\/\.\}"/);
    assert.match(buildScript, /WordHunter-\$\{release_version\}-aarch64\.dmg/);
  });

  it("keeps the Android webview URL out of the config (the runtime override is the single source of truth)", () => {
    const source = read("../../src-tauri/tauri.android.conf.json");
    const androidConfig = JSON.parse(source);
    const android = read("../../src-tauri/src/platform/android.rs");

    // The window must stay declared (android.rs builds it from this config),
    // but the URL is decided at runtime: the backend binds a port with a
    // fallback range and android.rs overrides the window URL before building.
    assert.equal(androidConfig.app.windows.length, 1);
    assert.equal(androidConfig.app.windows[0].create, false);
    assert.doesNotMatch(source, /"url"\s*:/);
    assert.doesNotMatch(source, /127\.0\.0\.1:\d+|localhost:\d+|3861\d/);
    assert.match(android, /ANDROID_SERVER_PORT/);
    assert.match(android, /WebviewUrl::External/);
  });

  it("opens external URLs on Windows without passing them through cmd.exe", () => {
    const cargo = read("../../src-tauri/Cargo.toml");
    const handlers = read("../../src-tauri/src/handlers.rs");
    const rustSources = filesBelow(new URL("../../src-tauri/src/", import.meta.url))
      .filter((file) => file.pathname.endsWith(".rs"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    assert.match(cargo, /open = \{ version = "5", features = \["shellexecute-on-windows"\] \}/);
    assert.match(handlers, /open::that_detached\(url\)/);
    assert.doesNotMatch(rustSources, /open::(?:that|with)\(/);
    assert.doesNotMatch(rustSources, /open::(?:that|with)_in_background\(/);
  });

  it("keeps the TypeScript build pinned, explicit, and outside source assets", () => {
    const packageJson = JSON.parse(read("../../package.json"));
    const lockfile = JSON.parse(read("../../package-lock.json"));
    const tsconfig = JSON.parse(read("../../tsconfig.json"));
    const stylelint = read("../../stylelint.config.mjs");
    const gitignore = read("../../.gitignore");
    const flatpak = parseSimpleYaml(read("../../com.wordhunter.app.yml"));
    const unixBuilds = [
      read("../../scripts/build-macos.sh"),
      read("../../scripts/build-flatpak.sh"),
      read("../../scripts/build-linux-native.sh"),
    ];

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
    for (const build of unixBuilds) {
      assert.match(
        build,
        /if \[\[ ! -f node_modules\/typescript\/bin\/tsc \|\| ! -f node_modules\/esbuild\/lib\/main\.js \]\]; then/,
      );
    }
    assert.match(stylelint, /postcss-html/);
    assert.match(gitignore, /^node_modules\/$/m);
    const source = flatpak.modules[0].sources.find((item) => item.type === "dir");
    assert.ok(source.skip.includes("node_modules"));
  });

  it("ships compiled JavaScript plus the runtime bundle and rejects stale native frontend builds", () => {
    const sourceFiles = filesBelow(new URL("../../src/web/", import.meta.url));
    const outputFiles = filesBelow(new URL("../../dist/web/", import.meta.url));
    const buildScript = read("../../scripts/build-frontend.mjs");
    const rustBuild = read("../../src-tauri/build.rs");
    const sourceModules = sourceFiles.filter((file) => file.pathname.endsWith(".ts"));
    const outputModules = outputFiles.filter((file) => file.pathname.endsWith(".js"));
    const runtimeBundles = outputModules.filter((file) => file.pathname.endsWith("/js/app.bundle.js"));

    assert.ok(sourceModules.length > 0);
    assert.equal(sourceFiles.filter((file) => file.pathname.endsWith(".js")).length, 0);
    assert.equal(runtimeBundles.length, 1);
    assert.equal(outputModules.length, sourceModules.length + runtimeBundles.length);
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

  it("validates HTML and derives every cache stamp and inline script from reviewed templates", () => {
    const packageJson = JSON.parse(read("../../package.json"));
    const buildScript = read("../../scripts/build-frontend.mjs");
    const buildHash = read("../../dist/web/.wordhunter-build.sha256").trim();
    const expectedStamp = buildHash.slice(0, 12);
    const builtHtml = [read("../../dist/web/index.html"), read("../../dist/web/templates/translator-popup.html")];
    const builtStyles = read("../../dist/web/styles.css");
    const localAssetUrls = builtHtml
      .flatMap((html) => [...html.matchAll(/\b(?:src|href)="([^"]+)"/gi)].map((match) => match[1]))
      .filter((url) => url.trim() !== "" && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url));
    const references = localAssetUrls.map((url) => new URLSearchParams(url.split("?", 2)[1] || "").get("v"));

    assert.equal(packageJson.scripts["lint:html"], "html-validate \"src/web/**/*.html\"");
    assert.match(packageJson.scripts["check:frontend"], /npm run lint:html/);
    assert.match(read("../../.htmlvalidate.json"), /html-validate:recommended/);
    assert.ok(references.length > 4, localAssetUrls.join(", "));
    assert.ok(references.every(Boolean), localAssetUrls.join(", "));
    assert.deepEqual([...new Set(references)], [expectedStamp]);
    assert.ok(builtHtml.some((html) => html.includes('src=""')));

    const bootstrapTemplate = read("../../src-tauri/templates/bootstrap.js");
    const popupTemplate = read("../../src-tauri/templates/popup-escape.js");
    const handlers = read("../../src-tauri/src/handlers.rs");
    const popup = read("../../src-tauri/src/popup.rs");
    assert.match(bootstrapTemplate, /__WH_TOKEN_JSON__/);
    assert.match(bootstrapTemplate, /__WH_SNAPSHOT_JSON__/);
    assert.match(popupTemplate, /__WH_CLOSE_URL_JSON__/);
    assert.match(handlers, /include_str!\("\.\.\/templates\/bootstrap\.js"\)/);
    assert.match(popup, /include_str!\("\.\.\/templates\/popup-escape\.js"\)/);
    assert.doesNotMatch(handlers, /window\.__qtBridge|window\.fetch = function/);
    assert.doesNotMatch(popup, /window\.addEventListener/);
  });

  it("uses a real HTML parser that rejects malformed markup", async () => {
    const { HtmlValidate } = await import("html-validate");
    const validator = new HtmlValidate();
    const report = await validator.validateString(
      '<!DOCTYPE html><html><body><div id="same"><span></div><div id="same"></div></body></html>',
      "malformed.html",
    );
    const ruleIds = report.results.flatMap((result) => result.messages.map((message) => message.ruleId));
    assert.equal(report.valid, false);
    assert.ok(ruleIds.includes("close-order") || ruleIds.includes("no-dup-id"), ruleIds.join(", "));
  });

  it("derives Snap validation from the application version and verifies the release digest", () => {
    const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
    const snapcraft = read("../../snap/snapcraft.yaml");
    const workflow = read("../../.github/workflows/snap-validation.yml");

    assert.match(snapcraft, new RegExp(`^version: ['\\"]${config.version}['\\"]$`, "m"));
    assert.match(
      snapcraft,
      new RegExp(`releases/download/WordHunter${config.version}/word-hunter_${config.version}_amd64\\.deb`, "m"),
    );
    assert.match(workflow, /require\('\.\/src-tauri\/tauri\.conf\.json'\)\.version/);
    assert.match(workflow, /steps\.app_version\.outputs\.version/);
    assert.match(workflow, /api\.github\.com\/repos\/Ironship\/WordHunter\/releases\/tags/);
    assert.match(workflow, /asset\?\.digest/);
  });

  it("keeps reviewable docs tracked while generated runtime payloads stay ignored", () => {
    const gitignore = read("../../.gitignore");
    const docs = read("../../docs/release-validation.md");

    assert.doesNotMatch(gitignore, /^docs\/\*\.md$/m);
    assert.doesNotMatch(gitignore, /^docs\/\*\/\*\.md$/m);
    assert.doesNotMatch(gitignore, /^src-tauri\/ocr-runner\/Cargo\.lock$/m);
    assert.match(docs, /WORDHUNTER_VALIDATE_CLIPPY=0/);
    assert.match(docs, /artifact-validation\.yml/);
  });

  it("keeps every id in index.html and translator-popup.html unique (regression: duplicate edit-book-title broke the Edit Book modal)", () => {
    for (const path of ["../../src/web/index.html", "../../src/web/templates/translator-popup.html"]) {
      const html = read(path);
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      assert.deepEqual([...new Set(duplicates)], [], `duplicate id(s) in ${path}: ${[...new Set(duplicates)].join(", ")}`);
    }
  });

  // Ids created at runtime by TypeScript (audited; #127 P1 ports the static
  // dialogs into TS renderers that run before cacheElements()). Any id
  // referenced from TS but absent here must exist in src/web/index.html.
  const TS_CREATED_IDS = new Set([
    "graph-due", // graphs/charts.ts (canvas)
    "graph-status", // graphs/charts.ts (canvas)
    "vocab-progress", // graphs container id (views/graphs.ts)
    "graphs-loading", // graphs/helpers.ts (busy overlay)
    "import-loading", // events/book-import.ts (busy overlay)
    "unsaved-confirm-dialog", // dialog-backdrop.ts
    "youglish-widget-in-modal", // youglish modal widget host
    "graph-vocab-progress", // graphs/charts.ts (canvas)
    "page-jump-input", // reader/pagination.ts (page-jump bar)
    "review-chart-canvas", // vocabulary/review-chart.ts (innerHTML)
    "review-heatmap", // vocabulary/review-chart.ts (innerHTML)
    "review-session-summary-done", // vocabulary/review-card.ts (innerHTML)
    "translator-download-prompt", // views/translator.ts (innerHTML)
    "data-folder-confirm-dialog", // events/settings.ts (dialog.id)
    "export-progress-eta", // sync-actions.ts (innerHTML)
    "export-progress-fill", // sync-actions.ts (innerHTML)
    "export-progress-text", // sync-actions.ts (innerHTML)
    "ocr-cancel", // events/book-import.ts (innerHTML)
    "ocr-progress-eta", // events/book-import.ts (innerHTML)
    "ocr-progress-text", // events/book-import.ts (innerHTML)
    "ocr-whole-book-confirm", // events/book-import.ts (dialog.id)
    "pocket-pdf-scan-warning", // events/book-import.ts (dialog.id)
    "reader-bookmarks-dialog", // reader/bookmarks.ts (renderBookmarksDialog)
    "reader-bookmark-form", // reader/bookmarks.ts (renderBookmarksDialog)
    "reader-bookmark-label", // reader/bookmarks.ts (renderBookmarksDialog)
    "reader-bookmark-submit", // reader/bookmarks.ts (renderBookmarksDialog)
    "reader-bookmark-cancel-edit", // reader/bookmarks.ts (renderBookmarksDialog)
    "reader-bookmark-list", // reader/bookmarks.ts (renderBookmarksDialog)
    "reader-bookmarks-close", // reader/bookmarks.ts (renderBookmarksDialog)
    "move-book-dialog", // events/move-book.ts (renderMoveBookDialog)
    "move-book-title", // events/move-book.ts (renderMoveBookDialog)
    "move-book-select", // events/move-book.ts (renderMoveBookDialog)
    "move-book-cancel", // events/move-book.ts (renderMoveBookDialog)
    "move-book-confirm", // events/move-book.ts (renderMoveBookDialog)
    "delete-book-dialog", // views/library.ts (renderDeleteBookDialog)
    "delete-book-title", // views/library.ts (renderDeleteBookDialog)
    "delete-book-message", // views/library.ts (renderDeleteBookDialog)
    "delete-book-cancel", // views/library.ts (renderDeleteBookDialog)
    "delete-book-confirm", // views/library.ts (renderDeleteBookDialog)
    "update-dialog", // update-checker.ts (renderUpdateDialog)
    "update-title", // update-checker.ts (renderUpdateDialog)
    "update-message", // update-checker.ts (renderUpdateDialog)
    "update-dismiss", // update-checker.ts (renderUpdateDialog)
    "update-skip", // update-checker.ts (renderUpdateDialog)
    "update-disable", // update-checker.ts (renderUpdateDialog)
    "update-open", // update-checker.ts (renderUpdateDialog)
    "toast", // toast.ts (renderToast)
    "toast-message", // toast.ts (renderToast)
    "language-onboarding-dialog", // onboarding.ts (renderLanguageOnboardingDialog)
    "language-onboarding-title", // onboarding.ts (renderLanguageOnboardingDialog)
    "language-onboarding-done", // onboarding.ts (renderLanguageOnboardingDialog)
    "pref-locale-onboarding", // onboarding.ts (renderLanguageOnboardingDialog)
    "pref-learning-language-onboarding", // onboarding.ts (renderLanguageOnboardingDialog)
  ]);

  it("keeps every byId target in dom.ts present in index.html or on the audited TS-created allowlist", () => {
    const domSource = read("../../src/web/js/dom.ts");
    const htmlIds = new Set([...read("../../src/web/index.html").matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    const byIdTargets = [...domSource.matchAll(/byId(?:<[^>]+>)?\("([^"]+)"\)/g)].map((match) => match[1]);
    const missing = [...new Set(byIdTargets.filter((id) => !htmlIds.has(id) && !TS_CREATED_IDS.has(id)))];
    assert.deepEqual(missing, [], `byId target(s) missing from index.html and allowlist: ${missing.join(", ")}`);
  });

  it("keeps every getElementById / querySelector('#id') literal in src/web/js present in index.html or on the audited TS-created allowlist", () => {
    const htmlIds = new Set([...read("../../src/web/index.html").matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    const missing = new Set();
    const tsSources = filesBelow(new URL("../../src/web/js/", import.meta.url)).filter((file) => file.pathname.endsWith(".ts"));
    for (const file of tsSources) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/getElementById\("([^"]+)"\)/g)) {
        if (!htmlIds.has(match[1]) && !TS_CREATED_IDS.has(match[1])) missing.add(match[1]);
      }
      for (const match of source.matchAll(/querySelector(?:All)?(?:<[^>]+>)?\(\s*["']#([A-Za-z0-9_-]+)["']\)/g)) {
        if (!htmlIds.has(match[1]) && !TS_CREATED_IDS.has(match[1])) missing.add(match[1]);
      }
    }
    assert.deepEqual([...missing].sort(), [], `id literal(s) missing from index.html and allowlist: ${[...missing].sort().join(", ")}`);
  });

  it("keeps the AppStream metainfo canonical in packaging/linux and mirrors it into flatpak", () => {
    const template = read("../../packaging/linux/com.wordhunter.app.metainfo.xml");
    const flatpak = read("../../flatpak/com.wordhunter.app.metainfo.xml");

    assert.match(
      template,
      /<launchable type="desktop-id">com\.wordhunter\.app\.desktop<\/launchable>/,
    );
    // The flatpak copy must be byte-identical to the packaging/linux template
    // (regression: drifted description and launchable) while both keep the
    // full release history the desktop contract pins (1.0.5~rc entries).
    assert.equal(flatpak, template);
    assert.match(flatpak, /<release version="1\.0\.10"/);
    assert.match(flatpak, /<release version="1\.0\.5~rc\.5"[^>]*type="development">/);
    assert.match(flatpak, /<release version="1\.0\.5~rc\.4"[^>]*type="development">/);
  });

  it("keeps the Flatpak cargo sources gate wired and the vendored tiny_http covered", () => {
    const cargo = read("../../src-tauri/Cargo.toml");
    const lock = read("../../src-tauri/Cargo.lock");
    const sources = JSON.parse(read("../../flatpak/cargo-sources.json"));
    const vendorManifest = read("../../src-tauri/vendor/tiny_http/Cargo.toml");
    const manifest = parseSimpleYaml(read("../../com.wordhunter.app.yml"));
    const workflow = parseSimpleYaml(read("../../.github/workflows/flatpak-validation.yml"));

    // tiny_http 0.12.0 is a vendored path dependency (Fix #105): the Flatpak
    // build compiles it from the repository dir source, so cargo-sources.json
    // must NOT list it as a crates.io archive.
    assert.match(cargo, /tiny_http = \{ path = "vendor\/tiny_http" \}/);
    assert.match(lock, /name = "tiny_http"\s+version = "0\.12\.0"/);
    assert.match(vendorManifest, /^version = "0\.12\.0"$/m);
    assert.ok(Array.isArray(sources));
    assert.ok(!sources.some((source) => source.url?.includes("/tiny_http-")));
    const wordHunterModule = manifest.modules.find((module) => module.name === "word-hunter");
    const dirSource = wordHunterModule.sources.find((item) => item.type === "dir");
    assert.ok(!dirSource.skip.includes("vendor"));
    const checkStep = stepByName(workflow.jobs["build-and-smoke-test"], "Verify Flatpak cargo sources are up to date");
    assert.match(checkStep.run, /update-flatpak-cargo-sources\.sh --check/);
  });

  it("keeps a root .editorconfig with the repository formatting contract", () => {
    const editorconfig = read("../../.editorconfig");

    assert.match(editorconfig, /^root = true$/m);
    assert.match(editorconfig, /^charset = utf-8$/m);
    assert.match(editorconfig, /^end_of_line = lf$/m);
    assert.match(editorconfig, /\[\*\.\{bat,ps1,cmd\}\][\s\S]*end_of_line = crlf/);
    assert.match(editorconfig, /\[\*\.\{js,ts,css,json,yml,yaml,html\}\][\s\S]*indent_size = 2/);
    assert.match(editorconfig, /\[\*\.rs\][\s\S]*indent_size = 4/);
  });

  it("keeps the stray dev/null file out and the .gitignore entry list alive", () => {
    const gitignore = read("../../.gitignore");
    const lines = gitignore.split(/\r?\n/);

    assert.equal(existsSync(new URL("../../dev/null", import.meta.url)), false);
    assert.ok(lines.includes("dev/"), ".gitignore must ignore the dev/ scratch directory");
    for (const dead of [
      "build/",
      "build_work/",
      "outputs/",
      "output/",
      "frontend-dist/",
      "scratch/",
      "TODO/",
      "My_Data/",
      ".agents/",
      ".codex/",
      ".kilo/",
      ".playwright-mcp/",
      "docs/android/",
      "docs/ddia-assessment.md",
    ]) {
      assert.ok(!lines.includes(dead), `.gitignore still contains the dead entry: ${dead}`);
    }
  });

  it("includes package.json in the frontend freshness hash on both sides of the contract", () => {
    const rustBuild = read("../../src-tauri/build.rs");
    const buildHash = read("../../scripts/build-input-hash.mjs");

    assert.match(rustBuild, /root\.join\("package\.json"\)/);
    assert.match(buildHash, /join\(root, "package\.json"\)/);
  });
});
