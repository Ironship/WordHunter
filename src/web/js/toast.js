import { els } from "./dom.js";

let toastTimer = null;

export function showToast(message) {
  if (!els.toast || !els.toastMessage) return;
  els.toastMessage.textContent = message;
  els.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("visible"), 3600);
}

function hideToast() {
  if (!els.toast) return;
  els.toast.classList.remove("visible");
  clearTimeout(toastTimer);
}

document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("toast-close");
  if (closeBtn) closeBtn.addEventListener("click", hideToast);
});
