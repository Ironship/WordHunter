import { state } from "../state.js";
import { t } from "../i18n.js";
import { escapeAttribute } from "../utils.js";

function imageSearchMessage(key) {
  return `<div style="font-size: 11px; color: var(--muted); padding: 0.25rem;">${t(key)}</div>`;
}

function uploadImageCardHtml(safeWord) {
  return `<div class="search-img-suggestion" style="cursor: pointer; text-align: center; border: 2px dashed var(--line); padding: 0.25rem; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; width: 180px;" data-action="upload-image" data-word="${safeWord}" title="${t("vocab.uploadOwnImage")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 32px; height: 32px; color: var(--muted);"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
      <div style="font-size: 12px; margin-top: 0.25rem; color: var(--blue); font-weight: 500;">${t("vocab.uploadOwnImage")} <span class="shortcut-badge">Ctrl+4</span></div>
      <input type="file" accept="image/*" style="display:none" data-upload-image="${safeWord}">
    </div>`;
}

function uploadImageHtml(safeWord) {
  return `<div style="display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; margin-top: 0.5rem;">${uploadImageCardHtml(safeWord)}</div>`;
}

function imageSuggestionHtml(page, index, safeWord) {
  const imageUrl = escapeAttribute(page.thumbnail.source);
  return `<div class="search-img-suggestion" style="cursor: pointer; text-align: center; border: 1px solid var(--line); padding: 0.25rem; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: space-between; width: 180px;" data-action="save-image" data-word="${safeWord}" data-img-url="${imageUrl}" title="${t("vocab.clickToSave")}"><img src="${imageUrl}" style="height: 120px; width: 100%; object-fit: cover; border-radius: 4px;" /><div style="font-size: 12px; margin-top: 0.25rem; color: var(--blue); font-weight: 500;">${t("vocab.selectImage")} <span class="shortcut-badge">Ctrl+${index + 1}</span></div></div>`;
}

function renderImageSuggestions(container, word, pages) {
  const safeWord = escapeAttribute(word);
  const suggestions = Object.values(pages || {}).filter((page) => page?.thumbnail?.source).slice(0, 3);
  if (!suggestions.length) {
    container.innerHTML = imageSearchMessage(pages ? "toast.imageSearchNoImages" : "toast.imageSearchNoResults") + uploadImageHtml(safeWord);
    return;
  }
  container.innerHTML = `<div style="display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; margin-top: 0.5rem;">${suggestions.map((page, index) => imageSuggestionHtml(page, index, safeWord)).join("")}${uploadImageCardHtml(safeWord)}</div>`;
}

export function renderImageSearch(container, word) {
  container.innerHTML = imageSearchMessage("toast.searching");
  const lang = state.preferences.learningLanguage || "de";
  fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(word)}&gsrlimit=10&prop=pageimages&format=json&pithumbsize=300&origin=*`)
    .then((response) => response.json())
    .then((data) => renderImageSuggestions(container, word, data?.query?.pages))
    .catch(() => {
      container.innerHTML = imageSearchMessage("toast.imageSearchError") + uploadImageHtml(escapeAttribute(word));
    });
}
