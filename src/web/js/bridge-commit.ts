// @ts-check

import { applyBridgeSnapshotToState, getDurableStateRevision, runExclusiveStateWrite, saveState } from "./state.js";
import { acknowledgeBackendSnapshot, loadBackendSnapshot } from "./store-bridge.js";

export async function saveStateAndReloadBridge(): Promise<WhBridgeSaveResult | void> {
  const result = await saveState();
  if (window.__qtBridge) {
    const expectedRevision = getDurableStateRevision();
    const snapshot = (result && result.snapshot) || await loadBackendSnapshot();
    if (snapshot) await runExclusiveStateWrite(async () => {
      if (applyBridgeSnapshotToState(snapshot, { expectedRevision })) {
        await acknowledgeBackendSnapshot(snapshot);
      }
    });
  }
  return result;
}

export async function reloadBridgeSnapshot(): Promise<boolean> {
  if (!window.__qtBridge) return false;
  const expectedRevision = getDurableStateRevision();
  const snapshot = await loadBackendSnapshot();
  if (!snapshot) return false;
  return runExclusiveStateWrite(async () => {
    if (!applyBridgeSnapshotToState(snapshot, { expectedRevision })) return false;
    await acknowledgeBackendSnapshot(snapshot);
    return true;
  });
}
