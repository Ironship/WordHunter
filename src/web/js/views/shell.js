// Status bar and view switcher renderer. UI only, no state mutation.
import { state, initialVocabKeys } from "../state.js";
import { STATUS_ORDER } from "../constants.js";
import { els } from "../dom.js";
import { t } from "../i18n.js";

export function renderShell() {
  document.documentElement.dataset.view = state.currentView;
  document.documentElement.classList.toggle("has-selected-word", state.currentView === "reader" && Boolean(state.selectedWord));
  els.navItems.forEach((button) => button.classList.toggle("active", button.dataset.view === state.currentView));
  els.views.forEach((view) => view.classList.toggle("active", view.id === `${state.currentView}-view`));
  const activeView = els.views.find((view) => view.id === `${state.currentView}-view`);
  const titleKey = activeView?.dataset.titleKey;
  els.pageTitle.textContent = titleKey ? t(titleKey) : t("app.title");

  const totals = countByStatus();
  els.overallCount.textContent = t("topbar.total", { n: totals.total });
  els.pillKnown.textContent = t("topbar.known", { n: totals.known });
  els.pillLearning.textContent = t("topbar.learning", { n: totals.learning });
  els.pillNew.textContent = t("topbar.new", { n: totals.session });
}

function countByStatus() {
  const totals = { total: 0, new: 0, learning: 0, known: 0, ignored: 0, session: 0 };
  Object.entries(state.vocab).forEach(([word, entry]) => {
    const status = STATUS_ORDER.includes(entry.status) ? entry.status : "new";
    if (status !== "ignored") totals.total += 1;
    totals[status] += 1;
    if (!initialVocabKeys.has(word)) {
      totals.session += 1;
    }
  });
  return totals;
}
