import { els } from "./dom.js";

let toastTimer = null;

export function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("visible"), 3600);
}

export function hideToast() {
  if (!els.toast) return;
  els.toast.classList.remove("visible");
  clearTimeout(toastTimer);
}

document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("toast-close");
  if (closeBtn) closeBtn.addEventListener("click", hideToast);
});
