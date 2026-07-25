export type OcrImageFormat = {
  extension: "jpg" | "png" | "webp";
  contentType: "image/jpeg" | "image/png" | "image/webp";
};

type ImageFileDescriptor = Pick<File, "name" | "type">;

export function ocrImageFormatFromExtension(name: string): OcrImageFormat | null {
  const extension = name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return { extension: "jpg", contentType: "image/jpeg" };
  if (extension === "png") return { extension: "png", contentType: "image/png" };
  if (extension === "webp") return { extension: "webp", contentType: "image/webp" };
  return null;
}

export function ocrImageFormatFromMime(type: string): OcrImageFormat | null {
  const mime = type.toLowerCase().split(";", 1)[0].trim();
  if (["image/jpeg", "image/jpg", "image/pjpeg"].includes(mime)) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (mime === "image/png") return { extension: "png", contentType: "image/png" };
  if (mime === "image/webp") return { extension: "webp", contentType: "image/webp" };
  return null;
}

export function isOcrImageFile(file: ImageFileDescriptor | null | undefined): boolean {
  return Boolean(file && (
    ocrImageFormatFromExtension(file.name)
    || ocrImageFormatFromMime(file.type)
    || file.type.toLowerCase().startsWith("image/")
  ));
}

export function validatedOcrImageFormat(file: ImageFileDescriptor): OcrImageFormat | null {
  const extensionFormat = ocrImageFormatFromExtension(file.name);
  const mimeFormat = ocrImageFormatFromMime(file.type);
  const mime = file.type.toLowerCase().split(";", 1)[0].trim();
  const genericMime = !mime || mime === "application/octet-stream";
  const hasExtension = /\.[^.]+$/.test(file.name);
  if (hasExtension && !extensionFormat) return null;
  if (extensionFormat && mimeFormat && extensionFormat.contentType !== mimeFormat.contentType) return null;
  if (extensionFormat && !mimeFormat && !genericMime) return null;
  return extensionFormat || mimeFormat;
}
