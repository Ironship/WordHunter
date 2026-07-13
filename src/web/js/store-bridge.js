// @ts-check

const JSON_HEADERS = () => ({
  "Content-Type": "application/json",
  "X-WH-Token": window.WH_TOKEN || ""
});

const TOKEN_HEADERS = () => ({
  "X-WH-Token": window.WH_TOKEN || ""
});

/** @param {Response} response @returns {Promise<WhRecord>} */
async function readOptionalJson(response) {
  return response.json().catch(() => ({}));
}

/**
 * @param {string} path
 * @param {WhRecord} [payload]
 * @param {{ requireBody?: boolean }} [options]
 * @returns {Promise<WhRecord>}
 */
export async function postStoreJson(path, payload, { requireBody = true } = {}) {
  if (!window.__qtBridge) return {};
  if (requireBody && (!payload || typeof payload !== "object")) {
    throw new Error(`${path} requires a JSON payload`);
  }
  const response = await fetch(path, {
    method: "POST",
    headers: JSON_HEADERS(),
    body: JSON.stringify(payload || {})
  });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return readOptionalJson(response);
}

/** @param {string} path @returns {Promise<WhRecord>} */
export async function postStoreCommand(path) {
  if (!window.__qtBridge) return {};
  const response = await fetch(path, {
    method: "POST",
    headers: TOKEN_HEADERS()
  });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return readOptionalJson(response);
}

/** @returns {Promise<unknown | null>} */
export async function loadBackendSnapshot() {
  if (!window.__qtBridge) return null;
  const response = await fetch("/__store/load", { cache: "no-store" });
  if (!response.ok) throw new Error(`/__store/load HTTP ${response.status}`);
  return response.json();
}

/**
 * @param {WhStoredTextInput} payload
 * @param {{ allowEmpty?: boolean }} [options]
 */
export async function upsertStoredText(payload, { allowEmpty = false } = {}) {
  if (!payload?.id || typeof payload.text !== "string" || (!allowEmpty && !payload.text.trim())) {
    throw new Error(`upsert_text requires id and ${allowEmpty ? "text" : "non-empty text"}`);
  }
  return postStoreJson("/__store/upsert_text", payload);
}

/** @param {string} id */
export async function deleteStoredText(id) {
  if (!id) throw new Error("delete_text requires id");
  return postStoreJson("/__store/delete_text", { id });
}
