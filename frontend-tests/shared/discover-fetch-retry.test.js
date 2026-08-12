import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Loads dist/web/js/discover/fetch-discover.js with a stubbed fetch and the
// real ../request.js fetchWithTimeout (runs in the same vm context).
async function loadFetchDiscover(fetchImpl) {
  const context = vm.createContext({
    AbortController,
    DOMException,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
  });
  const modules = new Map();
  const load = async (specifier, parent = null) => {
    if (modules.has(specifier)) return modules.get(specifier);
    const url = new URL(specifier, parent ?? import.meta.url);
    assert.ok(
      url.pathname.includes("/dist/web/js/"),
      `unexpected dependency ${specifier}`
    );
    const source = await readFile(url, "utf8");
    const module = new vm.SourceTextModule(source, { context, identifier: String(url) });
    modules.set(specifier, module);
    await module.link((dependency) => load(dependency, url));
    await module.evaluate();
    return module;
  };
  return (await load("../../dist/web/js/discover/fetch-discover.js")).namespace;
}

describe("Discover fetch retry (fetch-discover.ts)", () => {
  it("retries once when the first attempt fails and succeeds on the second", async () => {
    let calls = 0;
    const { fetchDiscover } = await loadFetchDiscover(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => ({}) };
    });
    const response = await fetchDiscover("https://gutendex.test/books", new AbortController().signal);
    assert.equal(calls, 2);
    assert.equal(response.ok, true);
  });

  it("propagates the last error when both attempts fail", async () => {
    const { fetchDiscover } = await loadFetchDiscover(async () => {
      throw new TypeError("Failed to fetch");
    });
    await assert.rejects(
      fetchDiscover("https://gutendex.test/books", new AbortController().signal),
      /Failed to fetch/
    );
  });

  it("propagates the HTTP status when both attempts get a non-ok response", async () => {
    const { fetchDiscover } = await loadFetchDiscover(async () => ({ ok: false, status: 503 }));
    await assert.rejects(
      fetchDiscover("https://gutendex.test/books", new AbortController().signal),
      /HTTP 503/
    );
  });

  it("does not retry when the caller has already aborted", async () => {
    let calls = 0;
    const { fetchDiscover } = await loadFetchDiscover(async () => {
      calls += 1;
      return { ok: true, json: async () => ({}) };
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fetchDiscover("https://gutendex.test/books", controller.signal),
      (error) => error != null && error.name === "AbortError"
    );
    assert.equal(calls, 0);
  });
});
