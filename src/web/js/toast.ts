import { els } from "./dom.js";

type ToastElements = {
  toast?: HTMLElement | null;
  toastMessage?: HTMLElement | null;
};

export type ToastType = "error" | "success" | "info";

const toastElements = els as ToastElements;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, _type?: ToastType) {
  if (!toastElements.toast || !toastElements.toastMessage) return;
  toastElements.toastMessage.textContent = message;
  toastElements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElements.toast!.classList.remove("visible"), 3600);
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
