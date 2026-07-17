type FocusableReaderToken = HTMLButtonElement;

export function requestReaderPageFocus(readerText = document.getElementById("reader-text")): void {
  if (readerText) readerText.dataset.focusAfterPageChange = "1";
}

export function applyPendingReaderPageFocus(readerText = document.getElementById("reader-text")): boolean {
  if (!readerText || readerText.dataset.focusAfterPageChange !== "1") return false;
  delete readerText.dataset.focusAfterPageChange;
  const firstToken = readerText.querySelector<FocusableReaderToken>(".word-token");
  if (!firstToken) return false;
  firstToken.focus({ preventScroll: true });
  window.lastActiveToken = firstToken;
  return true;
}

export function applyPendingReaderWordFocus(readerText = document.getElementById("reader-text")): boolean {
  if (!readerText) return false;
  const requestedIndex = readerText.dataset.focusWordIndex;
  const requestedWord = readerText.dataset.focusWord;
  if (requestedIndex === undefined && !requestedWord) return false;
  delete readerText.dataset.focusWordIndex;
  delete readerText.dataset.focusWord;
  const exactToken = requestedIndex !== undefined
    ? readerText.querySelector<FocusableReaderToken>(`.word-token[data-word-index="${requestedIndex}"]`)
    : null;
  const token = exactToken || (requestedWord
    ? readerText.querySelector<FocusableReaderToken>(`.word-token[data-word="${CSS.escape(requestedWord)}"]`)
    : null);
  if (!token) return false;
  token.focus({ preventScroll: true });
  window.lastActiveToken = token;
  return true;
}
