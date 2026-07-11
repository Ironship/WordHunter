import { applyBridgeSnapshotToState, saveState, state } from "./state.js";
import { loadBackendSnapshot } from "./store-bridge.js";

export async function saveStateAndReloadBridge(previousView = state.currentView || "library") {
  const result = await saveState();
  if (window.__qtBridge) {
    const snapshot = result?.snapshot || await loadBackendSnapshot();
    applyBridgeSnapshotToState(snapshot, { previousView });
  }
  return result;
}

export async function reloadBridgeSnapshot(previousView = state.currentView || "library") {
  if (!window.__qtBridge) return false;
  const snapshot = await loadBackendSnapshot();
  applyBridgeSnapshotToState(snapshot, { previousView });
  return true;
}
