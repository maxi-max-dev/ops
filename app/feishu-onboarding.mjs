export const MAXOPS_CONNECTOR_URL = "https://github.com/maxi-max-dev/ops/releases/download/v0.1.0/max-ops-agent-connector-2.1.0.tgz";

export const ONE_CLICK_INSTALL_ENDPOINTS = Object.freeze({
  status: "/api/install/status",
  workspace: "/api/install/workspace",
  dashboard: "/api/install/dashboard",
  pair: "/api/install/pair",
  taskUpdate: "/api/install/tasks/update",
  revoke: "/api/install/revoke",
});

// The checked-in static build has no confidential installer backend. A
// same-origin runtime can replace this state through /api/install/status.
export const PUBLIC_FEISHU_INSTALLATION = Object.freeze({
  status: "permission_gate",
  url: "",
  label: "安装暂未开放",
});

export function normalizeAgentName(value) {
  if (typeof value !== "string") return "我的 Agent";
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return normalized || "我的 Agent";
}

export function buildAgentPairingInstruction({ agentName, pairingUrl } = {}) {
  const name = normalizeAgentName(agentName);
  const pairing = typeof pairingUrl === "string" && /^https:\/\//.test(pairingUrl)
    ? `打开这个一次性配对链接：${pairingUrl}`
    : "使用 OPS 安装完成后生成的一次性配对链接";
  return `请把你自己以「${name}」接入我的 OPS。${pairing}，完成连接自检后领取测试任务，并向飞书回写一条 progress。无需向我索取任何技术 ID 或密钥。`;
}
