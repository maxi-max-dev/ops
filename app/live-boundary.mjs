export const DEMO_STORAGE_KEY = "max-ops-static-demo-v4";
export const LEGACY_STORAGE_KEYS = ["max-ops-demo-v3", "max-ops-live-state"];

export function clearLiveClientStorage(storage) {
  storage.removeItem(DEMO_STORAGE_KEY);
  for (const key of LEGACY_STORAGE_KEYS) storage.removeItem(key);
}

export function persistStaticDemo(storage, mode, state) {
  if (mode !== "local") {
    if (mode === "feishu" || mode === "feishu_syncing") clearLiveClientStorage(storage);
    return;
  }
  storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
}

export function mutationRefreshCopy(refreshed, receipt) {
  if (!refreshed) {
    return {
      complete: false,
      detail: `写回 receipt ${receipt?.receipt_id ?? "已生成"}，但星图刷新失败 · 点击同步重试`,
      event: `写回已成功，但 H5 星图尚未刷新 · ${receipt?.run_id ?? "run 待核"} / ${receipt?.receipt_id ?? "receipt 待核"}`,
    };
  }
  return { complete: true, detail: "Base、台账、星图与飞书回执已关联", event: "四方状态已刷新" };
}

export function canMutateStaticDemo(mode) {
  return mode === "local";
}

export function shouldRestoreStaticDemoOnUnauth(status, mode, requestedFeishu) {
  return status !== 404 || mode === "feishu" || mode === "feishu_syncing" || mode === "error" || requestedFeishu;
}

export function failedSyncBoundary(mode, requestedFeishu) {
  const recoveringLiveBoundary = mode === "feishu" || mode === "feishu_syncing" || mode === "error";
  return {
    restore: recoveringLiveBoundary,
    mode: requestedFeishu || recoveringLiveBoundary ? "error" : "local",
  };
}

export function unauthenticatedDemoState(initialProjects, initialRuns, staticEvent) {
  return {
    projects: initialProjects,
    runs: initialRuns,
    captures: [],
    lastReceipt: null,
    lastEvent: staticEvent,
    selectedId: initialProjects[0]?.id ?? "",
    selectedTaskId: "wr-7",
    selectedRunId: "run-feishu",
  };
}
