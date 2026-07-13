// @ts-check

import { applyBridgeSnapshotToState, saveState } from "./state.js";
import { loadBackendSnapshot } from "./store-bridge.js";

export async function saveStateAndReloadBridge() {
  const result = await saveState();
  if (window.__qtBridge) {
    const snapshot = result?.snapshot || await loadBackendSnapshot();
    applyBridgeSnapshotToState(snapshot);
  }
  return result;
}

export async function reloadBridgeSnapshot() {
  if (!window.__qtBridge) return false;
  const snapshot = await loadBackendSnapshot();
  applyBridgeSnapshotToState(snapshot);
  return true;
}
