// Shared settings-controls fixture for the vm harnesses that exercise
// preferences.js / settings-events.js against a minimal fake document.
// Since the P3 renderer ports (issue #127) moved the settings markup out of
// index.html, syncSettingsControls() reads controls via getElementById
// instead of the els cache. The fixture bridges the two: getElementById
// returns the els-backed stub when the test pre-populated it (assertions on
// els stay meaningful) and a cached stub otherwise; unknown ids -> null.

export function makeControlStub(id = "") {
  return {
    id,
    checked: false,
    hidden: false,
    disabled: false,
    style: {},
    textContent: "",
    value: "",
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    },
    setAttribute() {},
    addEventListener() {},
    appendChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
}

const OVERRIDES = {
  "pref-status-sound-volume-label": "prefStatusSoundVolumeLabel",
  "pref-card-stats-mode": "prefCardStatsMode",
  "pref-card-stats-mode-row": "prefCardStatsModeRow",
  "pref-selected-word-panel-items": "prefSelectedWordPanelItems",
  "pref-status-sounds-enabled": "prefStatusSoundsEnabled",
  "pref-status-sound-volume": "prefStatusSoundVolume",
  "pref-ui-scale-label": "prefUiScaleLabel"
};

function kebabToCamel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Returns a getElementById function backed by the els cache. Existing els
// entries (pre-populated by the test) are returned as-is; missing ones get a
// cached stub so repeated lookups stay referentially stable.
export function makeSettingsGetElementById(els, cache = new Map()) {
  return (id) => {
    if (id == null) return null;
    if (cache.has(id)) return cache.get(id);
    const key = OVERRIDES[id] || kebabToCamel(id);
    let el = els && key in els ? els[key] : null;
    if (!el) {
      el = makeControlStub(id);
      cache.set(id, el);
    }
    return el;
  };
}

// Installs the fixture onto a fake document object (mutates getElementById).
export function installSettingsFixture(document, els) {
  const cache = new Map();
  document.getElementById = makeSettingsGetElementById(els, cache);
  return cache;
}
