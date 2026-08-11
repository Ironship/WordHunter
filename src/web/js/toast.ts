import { els } from "./dom.js";

type ToastElements = {
  toast?: HTMLElement | null;
  toastMessage?: HTMLElement | null;
};

export type ToastType = "error" | "success" | "info";

const toastElements = els as ToastElements;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, type: ToastType = "info") {
  if (!toastElements.toast || !toastElements.toastMessage) return;
  toastElements.toastMessage.textContent = message;
  const toast = toastElements.toast;
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
  if (!toastElements.toast) return;
  toastElements.toast.classList.remove("visible");
  clearTimeout(toastTimer);
}

document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("toast-close");
  if (closeBtn) closeBtn.addEventListener("click", hideToast);
});
