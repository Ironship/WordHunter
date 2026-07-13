// @ts-check

const JSON_HEADERS = (): Record<string, string> => ({
  "Content-Type": "application/json",
  "X-WH-Token": window.WH_TOKEN || ""
});

const TOKEN_HEADERS = (): Record<string, string> => ({
  "X-WH-Token": window.WH_TOKEN || ""
});

async function readOptionalJson(response: Response): Promise<WhRecord> {
  return response.json().catch(() => ({}));
}

export async function postStoreJson(
  path: string,
  payload?: WhRecord,
  { requireBody = true }: { requireBody?: boolean } = {}
): Promise<WhRecord> {
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

export async function postStoreCommand(path: string): Promise<WhRecord> {
  if (!window.__qtBridge) return {};
  const response = await fetch(path, {
    method: "POST",
    headers: TOKEN_HEADERS()
  });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return readOptionalJson(response);
}

export async function loadBackendSnapshot(): Promise<WhBridgeSnapshot | null> {
  if (!window.__qtBridge) return null;
  const response = await fetch("/__store/load", { cache: "no-store" });
  if (!response.ok) throw new Error(`/__store/load HTTP ${response.status}`);
  return response.json();
}

export async function upsertStoredText(
  payload: Partial<WhStoredTextInput> & WhRecord,
  { allowEmpty = false }: { allowEmpty?: boolean } = {}
): Promise<WhRecord> {
  if (!payload?.id || typeof payload.text !== "string" || (!allowEmpty && !payload.text.trim())) {
    throw new Error(`upsert_text requires id and ${allowEmpty ? "text" : "non-empty text"}`);
  }
  return postStoreJson("/__store/upsert_text", payload);
}

export async function deleteStoredText(id: string): Promise<WhRecord> {
  if (!id) throw new Error("delete_text requires id");
  return postStoreJson("/__store/delete_text", { id });
}
