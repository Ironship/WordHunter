// @ts-check

import { applyBridgeSnapshotToState, getDurableStateRevision, runExclusiveStateWrite, saveState } from "./state.js";
import { acknowledgeBackendSnapshot, loadBackendSnapshot } from "./store-bridge.js";

export async function saveStateAndReloadBridge(
  options: { withSnapshot?: boolean } = {}
): Promise<WhBridgeSaveResult | void> {
  // `withSnapshot` folds the post-save reconciliation into the save request
  // itself (`?snapshot=1`): one round trip instead of save + full-store GET.
  // Book edits on large libraries used to pay a second ~store-size download
  // on every Save. When the response carries no snapshot (older in-flight
  // save, or the option was not requested) the explicit GET below runs as
  // before — behavior-preserving fallback.
  const result = await saveState(options);
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
