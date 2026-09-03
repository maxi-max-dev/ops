export type FeishuBoundaryMode = "preview" | "checking" | "live" | "error";

export type FeishuBoundaryPresentation = {
  mode: FeishuBoundaryMode;
  label: "PREVIEW" | "CHECKING" | "FEISHU LIVE";
  detail: string;
  actionSuffix: "预览" | "飞书写回";
};

export const FEISHU_EMBEDDED_ENDPOINTS = {
  state: "/api/feishu/state",
  taskCommand: "/api/commands",
  agentInstruction: "/api/feishu/instructions",
} as const;

/**
 * These host-facing capabilities deliberately stay behind an adapter boundary.
 * Zone A must verify the actual tenant surface before integration marks them live.
 */
export const FEISHU_HOST_CAPABILITIES = {
  workbenchContext: {
    status: "zone-a-required",
    fallback: "Render the responsive H5 without claiming host identity.",
  },
  openBaseRecord: {
    status: "h5-self-navigation",
    fallback: "Navigate the current Feishu webview to the same Base; do not claim Ask AI is embedded.",
  },
  interactiveCardAction: {
    status: "zone-a-required",
    fallback: "Use the existing task command and agent instruction HTTP contracts.",
  },
} as const;

type DataMode = "connecting" | "local" | "feishu" | "feishu_syncing" | "error";

export function presentFeishuBoundary(
  dataMode: DataMode,
  showcaseDemo: boolean,
): FeishuBoundaryPresentation {
  if (dataMode === "feishu") {
    return {
      mode: "live",
      label: "FEISHU LIVE",
      detail: "服务端已确认读取 OPS fresh copy；Base 仍是唯一业务真源",
      actionSuffix: "飞书写回",
    };
  }

  if (dataMode === "connecting" || dataMode === "feishu_syncing") {
    return {
      mode: "checking",
      label: "CHECKING",
      detail: "正在确认服务端投影；确认前所有操作保持预览边界",
      actionSuffix: "预览",
    };
  }

  return {
    mode: dataMode === "error" ? "error" : "preview",
    label: "PREVIEW",
    detail: showcaseDemo
      ? "虚构示例数据；操作只演示闭环，不写真实飞书"
      : "本地端内预览；操作只改当前页面，不写真实飞书",
    actionSuffix: "预览",
  };
}
