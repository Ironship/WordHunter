import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { t } from "../i18n.js";
import { showToast } from "../toast.js";
import { renderLibrary } from "../views/library.js";
import { runDiscoverSearch, getDiscoverHandlers } from "../views/discover.js";
import { addUserBook, removeUserBook, openBook } from "../book-actions.js";

export function bindDiscoverEvents({ addUserBook, removeUserBook }) {
  const discoverHandlers = getDiscoverHandlers({
    onAdd: addUserBook,
    onRemove: removeUserBook,
    onOpen: openBook
  });
  els.discoverForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.discover.query = els.discoverQuery.value.trim();
    state.discover.page = 1;
    saveState();
    runDiscoverSearch();
  });
  els.discoverSource.addEventListener("change", () => {
    state.discover.query = els.discoverQuery.value.trim();
    state.discover.source = els.discoverSource.value;
    state.discover.page = 1;
    saveState();

    const isGutenberg = state.discover.source === "gutenberg";
    if (els.discoverLevel) els.discoverLevel.disabled = !isGutenberg;
    if (els.discoverSort) els.discoverSort.disabled = (state.discover.source === "tatoeba" || state.discover.source === "wikipedia");

    runDiscoverSearch();
  });
  els.discoverLanguage.addEventListener("change", () => {
    state.discover.query = els.discoverQuery.value.trim();
    state.discover.language = els.discoverLanguage.value;
    state.discover.page = 1;
    saveState();
    runDiscoverSearch();
  });
  els.discoverSort.addEventListener("change", () => {
    state.discover.query = els.discoverQuery.value.trim();
    state.discover.sort = els.discoverSort.value;
    state.discover.page = 1;
    saveState();
    runDiscoverSearch();
  });
  if (els.discoverLevel) {
    els.discoverLevel.addEventListener("change", () => {
      state.discover.query = els.discoverQuery.value.trim();
      state.discover.level = els.discoverLevel.value;
      state.discover.page = 1;
      saveState();
      runDiscoverSearch();
    });
  }
  els.discoverResults.addEventListener("click", discoverHandlers.onResultsClick);
  els.discoverPagination.addEventListener("click", discoverHandlers.onResultsClick);
  els.discoverResults.addEventListener("change", discoverHandlers.onResultsChange);
  els.discoverSelectAll.addEventListener("click", () => discoverHandlers.toggleAll(true));
  els.discoverClear.addEventListener("click", () => discoverHandlers.toggleAll(false));
  els.discoverAddSelected.addEventListener("click", async () => {
    els.discoverAddSelected.disabled = true;
    const added = await discoverHandlers.addSelected();
    els.discoverAddSelected.disabled = false;
    showToast(added ? t("toast.addedMany", { n: added }) : t("toast.addedNone"));
    renderLibrary();
  });
  els.userBooksList.addEventListener("click", discoverHandlers.onUserBooksClick);
}
