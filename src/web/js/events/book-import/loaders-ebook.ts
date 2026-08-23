// EPUB/MOBI/AZW import through the backend ebook converter.
import { t } from "../../i18n.js";
import { fetchWithTimeout } from "../../request.js";
import { setImportLoading } from "./shared.js";
import { readFileAsBase64 } from "./ocr-progress.js";
import type { EbookImportResponse } from "./loaders.js";

export async function importEbookFile(file: File): Promise<EbookImportResponse> {
  if (!window.__qtBridge) {
    throw new Error(t("toast.ebookRequiresApp"));
  }
  setImportLoading(true);
  try {
    const response = await fetch("/__import/ebook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
      body: JSON.stringify({ filename: file.name, data: await readFileAsBase64(file) })
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `HTTP ${response.status}`);
    }
    return response.json() as Promise<EbookImportResponse>;
  } finally {
    setImportLoading(false);
  }
}
