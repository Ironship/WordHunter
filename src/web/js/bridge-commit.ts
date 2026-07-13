// @ts-check

import { applyBridgeSnapshotToState, saveState } from "./state.js";
import { loadBackendSnapshot } from "./store-bridge.js";

export async function saveStateAndReloadBridge(): Promise<WhBridgeSaveResult | void> {
  const result = await saveState();
  if (window.__qtBridge) {
    const snapshot = (result && result.snapshot) || await loadBackendSnapshot();
    applyBridgeSnapshotToState(snapshot);
  }
  return result;
}

export async function reloadBridgeSnapshot(): Promise<boolean> {
  if (!window.__qtBridge) return false;
  const snapshot = await loadBackendSnapshot();
  applyBridgeSnapshotToState(snapshot);
  return true;
}
