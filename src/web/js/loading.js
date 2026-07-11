const busyStates = new WeakMap();

function getBusyState(element) {
  let state = busyStates.get(element);
  if (!state) {
    state = {
      entries: new Map(),
      legacyToken: null,
      originallyInert: element.hasAttribute?.("inert") || false,
      originalAriaDisabled: element.getAttribute?.("aria-disabled")
    };
    busyStates.set(element, state);
  }
  return state;
}

function applyBusyState(element, state) {
  const busy = state.entries.size > 0;
  element.classList?.toggle("is-busy", busy);
  if (busy) element.setAttribute?.("aria-busy", "true");
  else element.removeAttribute?.("aria-busy");

  const shouldDisable = [...state.entries.values()].some(({ disable }) => disable);
  if (shouldDisable) {
    element.setAttribute?.("inert", "");
    element.setAttribute?.("aria-disabled", "true");
  } else {
    if (!state.originallyInert) element.removeAttribute?.("inert");
    if (state.originalAriaDisabled == null) element.removeAttribute?.("aria-disabled");
    else element.setAttribute?.("aria-disabled", state.originalAriaDisabled);
  }
  if (!busy) busyStates.delete(element);
}

export function beginElementBusy(element, { disable = false } = {}) {
  if (!element) return () => {};
  const state = getBusyState(element);
  const token = Symbol("busy");
  state.entries.set(token, { disable });
  applyBusyState(element, state);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.entries.delete(token);
    applyBusyState(element, state);
  };
}

export async function withElementBusy(element, operation, options = {}) {
  const release = beginElementBusy(element, options);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function setElementBusy(element, busy, { disable = false } = {}) {
  if (!element) return;
  const state = busyStates.get(element);
  if (busy) {
    const nextState = state || getBusyState(element);
    if (!nextState.legacyToken) nextState.legacyToken = Symbol("legacy-busy");
    nextState.entries.set(nextState.legacyToken, { disable });
    applyBusyState(element, nextState);
    return;
  }
  if (!state?.legacyToken) return;
  state.entries.delete(state.legacyToken);
  state.legacyToken = null;
  applyBusyState(element, state);
}
