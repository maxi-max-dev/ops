export const decisionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: ["task_state_update", "unknown"] },
    entity: { type: "string" },
    target_state: { type: "string", enum: ["todo", "running", "waiting", "done", "abandoned", "open", "none"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["intent", "entity", "target_state", "confidence", "reason"],
};

export function parseFeishuText(content) {
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content);
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

/** @returns {{action: "confirm" | "cancel", commandId: string} | null} */
export function parseGateReply(text) {
  const match = text.trim().match(/^(确认|取消)\s+(cmd_[0-9a-f-]{8,})$/i);
  if (!match) return null;
  return { action: match[1] === "确认" ? /** @type {const} */ ("confirm") : /** @type {const} */ ("cancel"), commandId: match[2] };
}

export function outputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

export function normalizeDecision(value, tasks) {
  if (!value || typeof value !== "object") throw new Error("Model returned no decision");
  const task = tasks.find((candidate) => candidate.id === value.entity);
  const confidence = Number(value.confidence);
  if (value.intent !== "task_state_update" || !task || !["todo", "running", "waiting", "done", "abandoned", "open"].includes(value.target_state) || !Number.isFinite(confidence)) {
    return { intent: "unknown", entity: "", target_state: "none", confidence: Number.isFinite(confidence) ? confidence : 0, reason: String(value.reason || "没有可靠匹配") };
  }
  return {
    intent: "task_state_update",
    entity: task.id,
    target_state: value.target_state,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: String(value.reason || "模型匹配到任务"),
  };
}

export function redactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(Bearer|token|secret|key)\s+[^\s,;]+/gi, "$1 [redacted]").slice(0, 500);
}

export function ledgerPresentation(status, reason, receiptId) {
  if (status === "succeeded") return { stage: "done", eta: "已完成", artifactKind: "WRITEBACK RECEIPT" };
  if (status === "failed") return { stage: "failed", eta: "执行失败", artifactKind: "FAILURE RECEIPT", summary: `${reason || "执行失败"}${receiptId ? ` · ${receiptId}` : ""}` };
  if (status === "superseded_unknown") return { stage: "failed", eta: "历史投影无法确认", artifactKind: "UNVERIFIED PROJECTION", summary: `${reason || "无法确认是否曾应用"}${receiptId ? ` · ${receiptId}` : ""}` };
  if (status === "needs_confirmation" || status === "needs_input") return { stage: "review", eta: status === "needs_confirmation" ? "等待确认" : "需要补充", artifactKind: "HUMAN GATE" };
  if (status === "projection_prepared" || status === "projection_inflight") return { stage: "running", eta: "写回核对中", artifactKind: "RECOVERABLE PROJECTION" };
  return { stage: "running", eta: "处理中", artifactKind: "RUN TRACE" };
}

export function shouldResumeQueuedCommand(row) {
  return row?.status === "queued" || row?.status === "processing";
}

export function processingLeaseMs(value) {
  return Math.max(100, Number(value) || 5_000);
}

export async function continueApprovedGate({ notifyStart, recordNotifyFailure, execute }) {
  try {
    await notifyStart();
  } catch (error) {
    try { await recordNotifyFailure(error); } catch { /* Diagnostics are best-effort too. */ }
  }
  return execute();
}
