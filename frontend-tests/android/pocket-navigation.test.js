import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function tagAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/\s([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function openingTags(html, tagName) {
  return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "gi"))]
    .map((match) => ({ source: match[0], index: match.index, tagName: tagName.toLowerCase(), attributes: tagAttributes(match[0]) }));
}

function openingTagByAttribute(html, tagName, attribute, value) {
  const element = openingTags(html, tagName).find((candidate) => candidate.attributes[attribute] === value);
  assert.ok(element, `Missing ${tagName}[${attribute}="${value}"]`);
  return element;
}

function ancestorOpeningTag(html, target, tagName) {
  const stack = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const match of html.matchAll(/<(\/)?([a-z][\w:-]*)\b[^>]*>/gi)) {
    if (match.index >= target.index) break;
    const name = match[2].toLowerCase();
    if (match[1]) {
      const index = stack.map((entry) => entry.tagName).lastIndexOf(name);
      if (index !== -1) stack.length = index;
    } else if (!voidTags.has(name) && !match[0].endsWith("/>")) {
      stack.push({ source: match[0], tagName: name, attributes: tagAttributes(match[0]) });
    }
  }
  const ancestor = [...stack].reverse().find((entry) => entry.tagName === tagName);
  assert.ok(ancestor, `Missing ${tagName} ancestor for ${target.source}`);
  return ancestor;
}

function declarationBlock(css, selector) {
  const normalizedSelector = selector.replace(/\s+/g, " ").trim();
  const declarations = {};
  let found = false;
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((value) => value.replace(/\s+/g, " ").trim());
    if (!selectors.includes(normalizedSelector)) continue;
    found = true;
    for (const declaration of match[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  assert.ok(found, `Missing CSS declaration block for ${selector}`);
  return declarations;
}

function hasSelector(css, selector) {
  const normalizedSelector = selector.replace(/\s+/g, " ").trim();
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some((match) => (
    match[1].split(",").map((value) => value.replace(/\s+/g, " ").trim()).includes(normalizedSelector)
  ));
}

function elementSource(html, tagName) {
  const openPattern = new RegExp(`<${tagName}\\b[^>]*>`, "i");
  const open = openPattern.exec(html);
  assert.ok(open, `Missing <${tagName}>`);
  const closePattern = new RegExp(`</${tagName}\\s*>`, "i");
  const close = closePattern.exec(html.slice(open.index + open[0].length));
  assert.ok(close, `Missing </${tagName}>`);
  const end = open.index + open[0].length + close.index + close[0].length;
  return html.slice(open.index, end);
}

describe("Android Pocket navigation", () => {
  it("declares settings and onboarding language controls", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");

    openingTagByAttribute(html, "select", "id", "pref-locale-settings");
    openingTagByAttribute(html, "select", "id", "pref-learning-language-settings");
    openingTagByAttribute(html, "dialog", "id", "language-onboarding-dialog");
    openingTagByAttribute(html, "select", "id", "pref-locale-onboarding");
    openingTagByAttribute(html, "img", "data-language-flag", "learning");
  });

  it("includes Discover and Sync in the Pocket navigation drawer", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    openingTagByAttribute(html, "button", "data-view", "discover");
    openingTagByAttribute(html, "button", "data-view", "sync");
    openingTagByAttribute(html, "section", "id", "discover-view");
    openingTagByAttribute(html, "option", "value", "gutenberg");
    assert.equal(hasSelector(css, '.pocket-mode .nav-item[data-view="discover"]'), false);
    assert.equal(hasSelector(css, '.pocket-mode .nav-item[data-view="sync"]'), false);
    assert.equal(declarationBlock(css, ".pocket-mode .nav-list")["grid-template-columns"], "minmax(0, 1fr)");
    assert.equal(declarationBlock(css, ".pocket-mode .sidebar").visibility, "hidden");
    assert.equal(declarationBlock(css, ".pocket-mode.pocket-navigation-open .sidebar").visibility, "visible");
    assert.match(html, /id="pocket-navigation-toggle"[\s\S]*M4 6h16M4 12h16M4 18h16/);
  });

  it("declares the Pocket-only Help entry and hides its bottom-nav duplicate", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    const navigation = readFileSync(new URL("../../src/web/js/events/navigation.js", import.meta.url), "utf8");
    const helpButton = openingTagByAttribute(html, "button", "data-open-view", "help");
    const helpRow = ancestorOpeningTag(html, helpButton, "div");

    assert.ok((helpRow.attributes.class || "").split(/\s+/).includes("pocket-only-setting"));
    assert.equal(declarationBlock(styles, ".pocket-only-setting").display, "none");
    assert.equal(declarationBlock(css, ".pocket-mode .pocket-only-setting").display, "grid");
    assert.equal(declarationBlock(css, '.pocket-mode .nav-item[data-view="help"]').display, "none");
    assert.match(navigation, /\[data-open-view\]/);
  });

  it("replaces desktop shortcuts with localized Pocket guidance on Android", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const pocketHeading = openingTagByAttribute(html, "h2", "id", "pocket-help-heading");
    const pocketPanel = ancestorOpeningTag(html, pocketHeading, "section");
    const desktopHeading = openingTagByAttribute(html, "h2", "id", "help-heading");
    const desktopPanel = ancestorOpeningTag(html, desktopHeading, "section");

    assert.ok((pocketPanel.attributes.class || "").split(/\s+/).includes("pocket-help-panel"));
    assert.ok((desktopPanel.attributes.class || "").split(/\s+/).includes("desktop-help-shortcuts"));
    assert.equal(declarationBlock(css, ".pocket-mode .desktop-help-shortcuts").display, "none");

    const requiredKeys = [
      "pocketHeading", "pocketIntro", "pocketControlsTitle", "pocketControlsBody",
      "pocketSyncTitle", "pocketSyncBody", "pocketLimitsTitle", "pocketLimitsBody"
    ];
    for (const code of ["de", "en", "es", "fr", "it", "ja", "pl", "ru", "uk"]) {
      const dict = JSON.parse(readFileSync(new URL(`../../src/web/i18n/${code}.json`, import.meta.url), "utf8"));
      for (const key of requiredKeys) assert.ok(dict.help[key], `${code}.help.${key}`);
      assert.doesNotMatch(dict.help.pocketControlsBody, /<kbd>/, `${code} Pocket help must not describe keyboard shortcuts`);
    }
  });

  it("declares an Enter-key search handler for the mobile keyboard", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const discoverEvents = readFileSync(new URL("../../src/web/js/events/discover.js", import.meta.url), "utf8");
    const query = openingTagByAttribute(html, "input", "id", "discover-query");

    assert.equal(query.attributes.enterkeyhint, "search");
    assert.match(discoverEvents, /discoverQuery\.addEventListener\("keydown"/);
    assert.match(discoverEvents, /event\.key !== "Enter"/);
    assert.match(discoverEvents, /els\.discoverQuery\.blur\(\)/);
  });

  it("declares remote fonts as a preload with a noscript fallback", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const noscript = elementSource(html, "noscript");
    const runtimeHtml = html.replace(noscript, "");
    const runtimeFontLinks = openingTags(runtimeHtml, "link").filter(({ attributes }) => attributes.href?.startsWith("https://fonts.googleapis.com/"));
    const fallbackFontLinks = openingTags(noscript, "link").filter(({ attributes }) => attributes.href?.startsWith("https://fonts.googleapis.com/"));

    assert.equal(runtimeFontLinks.length, 1);
    assert.equal(runtimeFontLinks[0].attributes.rel, "preload");
    assert.equal(runtimeFontLinks[0].attributes.as, "style");
    assert.equal(fallbackFontLinks.length, 1);
    assert.equal(fallbackFontLinks[0].attributes.rel, "stylesheet");
  });

  it("declares the topbar reload binding", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const navigation = readFileSync(new URL("../../src/web/js/events/navigation.js", import.meta.url), "utf8");

    openingTagByAttribute(html, "button", "id", "app-reload");
    assert.match(navigation, /document\.getElementById\("app-reload"\)\?\.addEventListener\("click", \(\) => window\.location\.reload\(\)\);/);
  });
});
