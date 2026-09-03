const FEISHU_AI_HASH_KEY = "feishu-ai";
export const FEISHU_AI_STORAGE_KEY = "max-ops:feishu-base-url";

export function normalizeFeishuBaseUrl(value) {
  try {
    const target = new URL(String(value ?? "").trim());
    const isFeishuHost = target.hostname === "feishu.cn" || target.hostname.endsWith(".feishu.cn");
    if (target.protocol !== "https:") return null;
    if (!isFeishuHost) return null;
    if (!target.pathname.startsWith("/base/")) return null;
    return target.toString();
  } catch {
    return null;
  }
}

export function parseFeishuAiHandoff(locationLike) {
  const hash = String(locationLike?.hash ?? "").replace(/^#/, "");
  const rawTarget = new URLSearchParams(hash).get(FEISHU_AI_HASH_KEY);
  if (!rawTarget) return null;
  return normalizeFeishuBaseUrl(rawTarget);
}

export function loadStoredFeishuBase(storageLike) {
  try {
    return normalizeFeishuBaseUrl(storageLike?.getItem?.(FEISHU_AI_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function buildFeishuAiLauncherUrl(publicUrl, baseUrl) {
  const launcher = new URL(publicUrl);
  const target = parseFeishuAiHandoff({
    hash: `#${FEISHU_AI_HASH_KEY}=${encodeURIComponent(baseUrl)}`,
  });
  if (!target) throw new Error("A private launcher must target a Feishu Base URL");
  launcher.hash = new URLSearchParams({ [FEISHU_AI_HASH_KEY]: target }).toString();
  return launcher.toString();
}
