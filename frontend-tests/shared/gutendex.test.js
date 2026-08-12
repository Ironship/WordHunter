import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadGutendex(fetchImpl) {
  const context = vm.createContext({
    AbortController,
    URLSearchParams,
    fetch: fetchImpl,
  });
  const mocks = {
    "../constants.js": { GUTENDEX_URL: "https://gutendex.test/books" },
    "../i18n.js": { t: (key) => key },
    "../utils.js": {
      cleanCatalogTitle: (value) => (typeof value === "string" ? value : ""),
    },
    "./fetch-discover.js": {
      fetchDiscover: (url, signal) => fetchImpl(url, { signal }),
    },
  };
  const modules = new Map();
  const load = async (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (mocks[specifier]) {
      const names = Object.keys(mocks[specifier]);
      const module = new vm.SyntheticModule(names, function define() {
        for (const name of names) this.setExport(name, mocks[specifier][name]);
      }, { context, identifier: specifier });
      modules.set(specifier, module);
      await module.link(() => {});
      await module.evaluate();
      return module;
    }
    assert.equal(specifier, "../../dist/web/js/discover/gutendex.js");
    const source = await readFile(new URL(specifier, import.meta.url), "utf8");
    const module = new vm.SourceTextModule(source, { context, identifier: specifier });
    modules.set(specifier, module);
    await module.link((dependency) => load(dependency));
    await module.evaluate();
    return module;
  };
  return (await load("../../dist/web/js/discover/gutendex.js")).namespace;
}

describe("Gutendex year sorting", () => {
  it("sorts the first page locally and disables misleading cross-page navigation", async () => {
    let requestedUrl = "";
    const gutendex = await loadGutendex(async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          count: 100,
          next: "https://gutendex.test/books?page=2",
          previous: "https://gutendex.test/books?page=0",
          results: [
            { id: 1, title: "Newer", authors: [{ birth_year: 1900 }] },
            { id: 2, title: "Older", authors: [{ birth_year: 1800 }] },
          ],
        }),
      };
    });

    const result = await gutendex.searchGutendex(
      { query: "", language: "en", sort: "year-asc", level: "", page: 1 },
      new AbortController().signal,
    );

    assert.match(requestedUrl, /sort=popular/);
    assert.match(requestedUrl, /page=1/);
    assert.deepEqual(Array.from(result.results, (book) => book.id), [2, 1]);
    assert.equal(result.next, false);
    assert.equal(result.previous, false);
  });

  it("preserves API pagination for server-side sorts", async () => {
    const gutendex = await loadGutendex(async () => ({
      ok: true,
      json: async () => ({ count: 2, next: true, previous: true, results: [] }),
    }));

    const result = await gutendex.searchGutendex(
      { query: "", language: "en", sort: "popular", level: "", page: 2 },
      new AbortController().signal,
    );

    assert.equal(result.next, true);
    assert.equal(result.previous, true);
  });
});
