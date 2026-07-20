const TOKEN_EDGE_MARGIN = 12;

function elementRect(element: Element | null | undefined): DOMRect | null {
  return element && typeof element.getBoundingClientRect === "function"
    ? element.getBoundingClientRect()
    : null;
}

export function keepReaderTokenVisible(token: Element | null | undefined): boolean {
  if (!token) return false;
  const container = (token.closest?.("#reader-text") || document.getElementById?.("reader-text")) as HTMLElement | null;
  if (!container?.contains?.(token)) return false;

  const tokenRect = elementRect(token);
  const containerRect = elementRect(container);
  if (!tokenRect || !containerRect || containerRect.height <= 0) return false;

  let visibleBottom = containerRect.bottom;
  const rootClasses = document.documentElement?.classList;
  if (rootClasses?.contains("pocket-mode") && rootClasses.contains("pocket-word-panel-open")) {
    const panelRect = elementRect(document.querySelector?.("#reader-view .reader-sidebar-wrapper"));
    if (panelRect && panelRect.top > containerRect.top && panelRect.top < visibleBottom) {
      visibleBottom = panelRect.top;
    }
  }

  const visibleTop = containerRect.top;
  if (tokenRect.top >= visibleTop + TOKEN_EDGE_MARGIN
    && tokenRect.bottom <= visibleBottom - TOKEN_EDGE_MARGIN) return false;

  const visibleHeight = Math.max(1, visibleBottom - visibleTop);
  const tokenCenter = tokenRect.top - containerRect.top + container.scrollTop + tokenRect.height / 2;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  const top = Math.max(0, Math.min(maxScroll, Math.round(tokenCenter - visibleHeight / 2)));
  if (typeof container.scrollTo === "function") container.scrollTo({ top, behavior: "auto" });
  else container.scrollTop = top;
  return true;
}
