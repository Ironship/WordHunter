// File loaders: ebook/text dispatch and size guards.
import { state } from "../../state.js";
import { t } from "../../i18n.js";
import { decodeImportedTextBytes, parseImportedTextFile, titleFromImportedFileName } from "../../subtitles.js";
import { isAndroidPlatform } from "../../platform.js";
import { effectiveLearningLanguage } from "../../translator-preferences.js";
import { isOcrImageFile } from "../../ocr-image-format.js";
import {
  autofillImportCover,
  autofillImportField,
  clearAutofilledImportFields,
  clearPendingImportMeta,
  el,
  isEbookFile,
  isPdfFile,
  setImportLoading,
  MAX_DESKTOP_IMPORT_FILE_BYTES,
  MAX_POCKET_IMPORT_FILE_BYTES,
  MAX_SERIALIZED_IMPORT_TEXT_BYTES,
} from "./shared.js";
import { resetYoutubeTracks } from "./youtube.js";
import { importPdfFile, importOcrImageFile } from "./pdf-ocr.js";
import { importEbookFile } from "./loaders-ebook.js";

export type EbookImportResponse = {
  title?: string;
  author?: string;
  text?: string;
  coverDataUrl?: string;
};

type ImportHandler = {
  /** Matches by file properties; must not have side effects. */
  matches: (file: File) => boolean;
  /** Size limit key: "import" uses the desktop/pocket import-byte guards. */
  limit?: "import";
  import: (file: File) => Promise<boolean | void>;
};

async function importEbookViaForm(file: File): Promise<boolean> {
  const maxImportBytes = isAndroidPlatform()
    ? MAX_POCKET_IMPORT_FILE_BYTES
    : MAX_DESKTOP_IMPORT_FILE_BYTES;
  const ebook = await importEbookFile(file);
  if (!ebook.text) throw new Error(t("toast.importedEbookEmpty"));
  if (new TextEncoder().encode(JSON.stringify(ebook.text)).byteLength > MAX_SERIALIZED_IMPORT_TEXT_BYTES) {
    throw new Error(t("toast.importFileTooLarge", { mb: Math.floor(maxImportBytes / (1024 * 1024)) }));
  }
  const importText = el<HTMLTextAreaElement>("import-text");
  if (importText) importText.value = ebook.text;
  autofillImportField("title", ebook.title || titleFromImportedFileName(file.name));
  autofillImportField("author", ebook.author || "");
  if (ebook.coverDataUrl) autofillImportCover(ebook.coverDataUrl);
  return true;
}

const IMPORT_HANDLERS: ImportHandler[] = [
  { matches: isPdfFile, import: importPdfFile },
  { matches: isOcrImageFile, import: importOcrImageFile },
  { matches: isEbookFile, limit: "import", import: importEbookViaForm },
];

// What Pocket can import. The Android picker also offers
// application/octet-stream files (see MOBILE_IMPORT_ACCEPT), so MOBI/AZW and
// binaries can arrive here and must not be decoded as text.
const MOBILE_IMPORT_EXTENSIONS = /\.(txt|md|markdown|srt|vtt|ass|ssa|epub|pdf)$/i;
// Types the picker reports for files it offered by type; some providers
// give text files no extension or an unusual one. Subtitles are not among
// them: their parser is chosen by extension.
const MOBILE_IMPORT_TYPES = new Set(["text/plain", "text/markdown", "application/pdf"]);

function mobileCanImport(file: File): boolean {
  return MOBILE_IMPORT_EXTENSIONS.test(file.name || "") || MOBILE_IMPORT_TYPES.has(file.type);
}

function assertImportFileLimit(file: File): number {
  const maxImportBytes = isAndroidPlatform()
    ? MAX_POCKET_IMPORT_FILE_BYTES
    : MAX_DESKTOP_IMPORT_FILE_BYTES;
  if (file.size > maxImportBytes) {
    throw new Error(t("toast.importFileTooLarge", { mb: Math.floor(maxImportBytes / (1024 * 1024)) }));
  }
  return maxImportBytes;
}

export async function loadImportFile(file: File): Promise<boolean | void> {
  if (isAndroidPlatform() && !mobileCanImport(file)) {
    throw new Error(t("toast.mobileImportUnsupported"));
  }
  clearPendingImportMeta();
  clearAutofilledImportFields();
  resetYoutubeTracks(false);

  for (const handler of IMPORT_HANDLERS) {
    if (!handler.matches(file)) continue;
    if (handler.limit === "import") assertImportFileLimit(file);
    return handler.import(file);
  }

  const maxImportBytes = assertImportFileLimit(file);
  const rawText = decodeImportedTextBytes(
    await file.arrayBuffer(),
    effectiveLearningLanguage(state.preferences)
  );
  const text = parseImportedTextFile(file, rawText);
  if (!text) throw new Error(t("toast.importedFileEmpty"));
  if (new TextEncoder().encode(JSON.stringify(text)).byteLength > MAX_SERIALIZED_IMPORT_TEXT_BYTES) {
    throw new Error(t("toast.importFileTooLarge", { mb: Math.floor(maxImportBytes / (1024 * 1024)) }));
  }
  const importText = el<HTMLTextAreaElement>("import-text");
  if (importText) importText.value = text;
  autofillImportField("title", titleFromImportedFileName(file.name));
}
