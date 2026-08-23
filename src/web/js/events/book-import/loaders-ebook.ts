// EPUB/MOBI/AZW import through the backend ebook converter.
import { t } from "../../i18n.js";
import { httpPost } from "../../http.js";
import { setImportLoading } from "./shared.js";
import { readFileAsBase64 } from "./ocr-progress.js";
import type { EbookImportResponse } from "./loaders.js";

export async function importEbookFile(file: File): Promise<EbookImportResponse> {
  if (!window.__qtBridge) {
    throw new Error(t("toast.ebookRequiresApp"));
  }
  setImportLoading(true);
  try {
    const response = await httpPost("/__import/ebook", { filename: file.name, data: await readFileAsBase64(file) }, { timeoutMs: 120_000 });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `HTTP ${response.status}`);
    }
    return response.json() as Promise<EbookImportResponse>;
  } finally {
    setImportLoading(false);
  }
}
