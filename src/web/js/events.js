import { bindSettingsEvents } from "./events/settings.js";
import { bindTranslatorEvents } from "./events/translator.js";
import { bindNavigationEvents } from "./events/navigation.js";
import { bindDiscoverEvents } from "./events/discover.js";
import { bindBookImportEvents } from "./events/book-import.js";
import { bindGlobalActionEvents } from "./events/global-actions.js";
import { bindVocabularyFilterEvents } from "./events/vocabulary-filters.js";
import { bindMoveBookEvents } from "./events/move-book.js";
import { bindWordEditorEvents } from "./events/word-editor.js";
import { addUserBook, removeUserBook } from "./book-actions.js";

export function bindEvents() {
  bindNavigationEvents();
  bindBookImportEvents();
  bindGlobalActionEvents();
  bindVocabularyFilterEvents();
  bindMoveBookEvents();
  bindWordEditorEvents();
  bindSettingsEvents();
  bindTranslatorEvents();
  bindDiscoverEvents({ addUserBook, removeUserBook });
}
