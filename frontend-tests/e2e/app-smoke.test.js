// End-to-end smoke test for the real desktop app: boots the built binary in a
// sandboxed data directory, verifies it serves the embedded UI, that the
// bootstrap token is injected, and that the store answers snapshot requests.
//
// Safety:
// - The child runs with APPDATA/LOCALAPPDATA pointed at a temp dir, so the
//   user's real data, config and WebView2 profile are never touched.
// - WebView2 GPU is disabled to avoid overlay-injection crashes (RTSS etc.).
// - The test SKIPS when a WordHunter instance is already running (the app is
//   single-instance; a second launch would just focus the first).
// - Only runs on Windows; elsewhere (CI) it is skipped before any build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(REPO, "src-tauri", "target", "debug", "word-hunter-rustified.exe");
const EXE_NAME = "word-hunter-rustified.exe";
const IS_WINDOWS = process.platform === "win32";

function appInstanceRunning() {
  const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${EXE_NAME}`], { encoding: "utf8" });
  return (out.stdout || "").includes(EXE_NAME);
}

/**
 * Listening TCP ports owned by the given PID. Uses PowerShell
 * Get-NetTCPConnection: netstat's state column ("LISTENING") is localized on
 * non-English Windows, which would silently break port detection.
 */
function listeningPorts(pid) {
  const script = `Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`;
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 15000
  });
  return (out.stdout || "")
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((port) => Number.isInteger(port) && port > 0);
}

/** Newest mtime under dist/web (ms since epoch), or 0 when absent. */
function newestDistMtime() {
  const dist = path.join(REPO, "dist", "web");
  if (!existsSync(dist)) return 0;
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dist);
  return files.reduce((newest, file) => Math.max(newest, statSync(file).mtimeMs), 0);
}

function httpGet(port, urlPath, token) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: urlPath,
          method: "GET",
          headers: {
            Host: `127.0.0.1:${port}`,
            ...(token ? { "X-WH-Token": token } : {}),
            Connection: "close"
          },
          timeout: 20000
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => {
            if (response.statusCode !== 200) {
              reject(new Error(`HTTP ${response.statusCode} for ${urlPath}`));
            } else {
              resolve(body);
            }
          });
        }
      );
      request.on("error", (error) => {
        // The server races the webview's own first request during cold boot;
        // a dropped connection here is transient, so retry a few times.
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 1500);
        } else {
          reject(error);
        }
      });
      request.on("timeout", () => request.destroy(new Error(`request timed out: ${urlPath}`)));
      request.end();
    };
    attempt(3);
  });
}

test(
  "desktop app boots, serves the embedded UI and answers store requests",
  { skip: !IS_WINDOWS ? "smoke test requires the Windows desktop app" : false },
  async (t) => {
    // build.rs embeds dist/web at compile time — rebuild when the frontend is
    // newer than the binary (or the binary is missing) so the smoke test
    // validates the current UI, not a stale embedded copy.
    if (!existsSync(BIN) || newestDistMtime() > statSync(BIN).mtimeMs) {
      const build = spawnSync("cargo", ["build"], {
        cwd: path.join(REPO, "src-tauri"),
        encoding: "utf8",
        timeout: 900000
      });
      assert.equal(build.status, 0, `cargo build failed: ${(build.stderr || "").slice(-500)}`);
    }
    const running = appInstanceRunning();
    if (running) {
      const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${EXE_NAME}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
      const pidHint = (out.stdout || "").match(/,(\d+),/)?.[1] || "?";
      t.skip(`WordHunter is already running (pid ${pidHint}); close it before running the app smoke test`);
      return;
    }

    const sandbox = mkdtempSync(path.join(tmpdir(), "wh-e2e-"));
    let child = null;
    try {
      child = spawn(BIN, [], {
        env: {
          ...process.env,
          APPDATA: sandbox,
          LOCALAPPDATA: sandbox,
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--disable-gpu"
        },
        stdio: "ignore",
        windowsHide: true
      });

      let port = null;
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline && port === null) {
        if (child.exitCode !== null) {
          throw new Error(`app exited early with code ${child.exitCode}`);
        }
        const ports = listeningPorts(child.pid);
        if (ports.length > 0) port = ports[0];
        else await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.ok(port, "the app did not open a listening port within 120s");

      // Let the webview finish its own cold-start request before probing.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const html = await httpGet(port, "/index.html");
      assert.match(html, /<html[\s>]/i, "embedded index.html must be served");
      assert.match(html, /class="app-shell"/, "the app shell must be present");

      const tokenMatch = html.match(/window\.WH_TOKEN\s*=\s*"([^"]+)"/);
      assert.ok(tokenMatch, "the bootstrap token must be embedded in index.html");

      const snapshot = await httpGet(port, "/__store/load", tokenMatch[1]);
      const data = JSON.parse(snapshot);
      assert.equal(typeof data, "object");
      assert.ok("records" in data || "vocab" in data, "store snapshot must be a record payload");
    } finally {
      if (child) {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      // Dying WebView2 children can briefly hold the sandbox dir; retry on
      // EBUSY/EPERM instead of failing the (already passed) test.
      try {
        rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // Best effort — a leaked temp dir is preferable to a red test.
      }
    }
  }
);
