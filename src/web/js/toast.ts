export type ToastType = "error" | "success" | "info";

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Builds the toast element once (idempotent). Called during app boot
 * before cacheElements() (app.ts); the close button binds itself here, so
 * the old DOMContentLoaded pass is not needed and the element is available
 * to every consumer from boot on. data-i18n-attr is applied by the
 * boot-time applyTranslations() pass.
 */
export function renderToast(): HTMLElement {
  const existing = document.getElementById("toast");
  if (existing) return existing;

  const toast = document.createElement("div");
  toast.id = "toast";
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");

  const message = document.createElement("span");
  message.id = "toast-message";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.id = "toast-close";
  close.setAttribute("data-i18n-attr", "aria-label=reader.close");
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", hideToast);

  toast.appendChild(message);
  toast.appendChild(close);
  document.body.appendChild(toast);
  return toast;
}

export function showToast(message: string, type: ToastType = "info") {
  const toast = document.getElementById("toast");
  const toastMessage = document.getElementById("toast-message");
  if (!toast || !toastMessage) return;
  toastMessage.textContent = message;
  toast.classList.remove("toast-error", "toast-success", "toast-info");
  toast.classList.add(type === "error" ? "toast-error" : type === "success" ? "toast-success" : "toast-info");
  // Errors should be announced with alert semantics, not polite status.
  if (type === "error") toast.setAttribute("role", "alert");
  else toast.setAttribute("role", "status");
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3600);
}

function hideToast() {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.classList.remove("visible");
  clearTimeout(toastTimer);
}
