import { state } from "../state.js";
import { t } from "../i18n.js";
import { escapeAttribute } from "../utils.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";

interface ImageSearchPage {
  thumbnail: {
    source: string;
  };
}

interface WikipediaImageSearchResponse {
  query?: {
    pages?: Record<string, unknown>;
  };
}

function isImageSearchPage(page: unknown): page is ImageSearchPage {
  if (!page || typeof page !== "object") return false;
  const thumbnail = (page as { thumbnail?: unknown }).thumbnail;
  return !!thumbnail
    && typeof thumbnail === "object"
    && typeof (thumbnail as { source?: unknown }).source === "string";
}

function imageSearchMessage(key: string): string {
  return `<div class="caption-tiny">${t(key)}</div>`;
}

function uploadImageCardHtml(safeWord: string): string {
  return `<div class="search-img-suggestion tile-add" role="button" tabindex="0" data-action="upload-image" data-word="${safeWord}" title="${t("vocab.uploadOwnImage")}" aria-label="${t("vocab.uploadOwnImage")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-32-muted"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
      <div class="hint-blue">${t("vocab.uploadOwnImage")} <span class="shortcut-badge">Ctrl+4</span></div>
      <input type="file" accept="image/*" data-upload-image="${safeWord}" class="display-none">
    </div>`;
}

function uploadImageHtml(safeWord: string): string {
  return `<div class="justify-center-wrap-m-t-05">${uploadImageCardHtml(safeWord)}</div>`;
}

function imageSuggestionHtml(page: ImageSearchPage, index: number, safeWord: string): string {
  const imageUrl = escapeAttribute(page.thumbnail.source);
  return `<button class="search-img-suggestion tile-solid" type="button" data-action="save-image" data-word="${safeWord}" data-img-url="${imageUrl}" title="${t("vocab.clickToSave")}"><img src="${imageUrl}" alt=""  class="thumb-120" /><span class="hint-blue">${t("vocab.selectImage")} <span class="shortcut-badge">Ctrl+${index + 1}</span></span></button>`;
}

function renderImageSuggestions(container: HTMLElement, word: string, pages?: Record<string, unknown>): void {
  const safeWord = escapeAttribute(word);
  const suggestions = Object.values(pages || {}).filter(isImageSearchPage).slice(0, 3);
  if (!suggestions.length) {
    container.innerHTML = imageSearchMessage(pages ? "toast.imageSearchNoImages" : "toast.imageSearchNoResults") + uploadImageHtml(safeWord);
    return;
  }
  container.innerHTML = `<div class="justify-center-wrap-m-t-05">${suggestions.map((page, index) => imageSuggestionHtml(page, index, safeWord)).join("")}${uploadImageCardHtml(safeWord)}</div>`;
}

export function renderImageSearch(container: HTMLElement, word: string): void {
  container.innerHTML = imageSearchMessage("toast.searching");
  const lang = effectiveLearningLanguage(state.preferences).split("-")[0];
  fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(word)}&gsrlimit=10&prop=pageimages&format=json&pithumbsize=300&origin=*`)
    .then((response) => response.json() as Promise<WikipediaImageSearchResponse>)
    .then((data) => renderImageSuggestions(container, word, data?.query?.pages))
    .catch(() => {
      container.innerHTML = imageSearchMessage("toast.imageSearchError") + uploadImageHtml(escapeAttribute(word));
    });
}
