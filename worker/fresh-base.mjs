/**
 * Pure projection from the OPS fresh-copy Base contract into the existing UI model.
 * This module intentionally owns no storage: Base remains the only business source of truth.
 */

export const REQUIRED_FRESH_TABLES = {
  projects: ["项目"],
  tasks: ["任务"],
  events: ["Agent事件", "Agent 事件"],
  feedback: ["问题反馈", "问题/反馈", "问题／反馈"],
  receipts: ["产物回执", "产物/回执", "产物／回执"],
};

export function fieldText(value, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map((item) => fieldText(item)).filter(Boolean).join("、");
  if (value && typeof value === "object") {
    return fieldText(value.text ?? value.name ?? value.value ?? value.record_id ?? value.id, fallback);
  }
  return fallback;
}

function firstField(fields, names, fallback = "") {
  for (const name of names) {
    const value = fieldText(fields?.[name]);
    if (value) return value;
  }
  return fallback;
}

function hasAnyField(fields, names) {
  return names.some((name) => Boolean(fieldText(fields?.[name])));
}

function relationIds(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const nested = item.record_ids ?? item.link_record_ids ?? item.recordIds;
    if (Array.isArray(nested)) return nested.filter((id) => typeof id === "string" && id);
    const id = item.record_id ?? item.recordId ?? item.id;
    return typeof id === "string" && id ? [id] : [];
  });
}

export function normalizedTableName(value) {
  return fieldText(value).toLowerCase().replace(/[\s/／·._-]+/g, "");
}

export function resolveFreshTables(tables) {
  const result = {};
  for (const [key, aliases] of Object.entries(REQUIRED_FRESH_TABLES)) {
    const accepted = new Set(aliases.map(normalizedTableName));
    const found = tables.find((table) => accepted.has(normalizedTableName(table.name)));
    if (found) result[key] = found;
  }
  const missing = Object.keys(REQUIRED_FRESH_TABLES).filter((key) => !result[key]);
  return { tables: result, missing };
}

export function taskStage(fields) {
  const value = firstField(fields, ["五态", "阶段", "状态", "state", "status"]).toLowerCase();
  if (/完成|已完成|done|finish|closed|success/.test(value)) return "done";
  if (/放弃|取消|abandon|cancel/.test(value)) return "abandoned";
  if (/进行|执行|running|working|doing|claimed|ack/.test(value)) return "running";
  if (/等待|等外部|阻塞|blocked|waiting|question|review/.test(value)) return "waiting";
  if (/待办|未开始|open|todo|new|pending/.test(value)) return "todo";
  if (fields?.["完成"] === true) return "done";
  return "open";
}

function timestamp(value, fallback = 0) {
  const raw = fieldText(value);
  const number = Number(raw);
  if (Number.isFinite(number) && number > 0) return number < 10_000_000_000 ? number * 1000 : number;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function accentFor(seed) {
  const palette = ["#315bd6", "#c66543", "#18846f", "#6b58b7", "#c58a25", "#287d9f"];
  const hash = [...seed].reduce((total, character) => total + (character.codePointAt(0) ?? 0), 0);
  return palette[hash % palette.length];
}

function agentAccent(seed) {
  const palette = ["#3f63f2", "#ce6b4c", "#16806d", "#9659c7", "#b4811e", "#3387a5"];
  const hash = [...seed].reduce((total, character) => total + (character.codePointAt(0) ?? 0), 0);
  return palette[hash % palette.length];
}

function runStage(value) {
  const text = fieldText(value).toLowerCase();
  if (/done|finish|完成|succeed|acknowledged/.test(text)) return "done";
  if (/failed|失败|error/.test(text)) return "failed";
  if (/blocked|waiting|question|review|等待|阻塞/.test(text)) return "review";
  return "running";
}

function messageStatus(value) {
  const text = fieldText(value).toLowerCase();
  if (/acknowledged|已确认|finished|done|完成/.test(text)) return "acknowledged";
  if (/delivered|claimed|已领取|已送达|processing|running/.test(text)) return "delivered";
  if (/answered|replied|已回复/.test(text)) return "answered";
  if (/preparing/.test(text)) return "preparing";
  return "pending";
}

function kindForFeedback(fields) {
  const kind = firstField(fields, ["type", "类型", "kind"]).toLowerCase();
  if (/question|问题|提问/.test(kind)) return "question";
  if (/answer|回复|答复/.test(kind)) return "answer";
  return "instruction";
}

function taskProjectId(taskFields, projectByRecordId, projectByPublicId) {
  const publicId = firstField(taskFields, ["project_id", "项目ID", "项目 id"]);
  if (publicId && projectByPublicId.has(publicId)) return publicId;
  for (const name of ["项目关联", "项目", "所属项目"]) {
    for (const recordId of relationIds(taskFields?.[name])) {
      const project = projectByRecordId.get(recordId);
      if (project) return project.id;
    }
  }
  return publicId || "unfiled";
}

function eventSignal(record, fallbackTime) {
  const fields = record.fields ?? {};
  const taskId = firstField(fields, ["task_id", "任务ID", "任务 id"]);
  const eventKind = firstField(fields, ["kind", "类型", "事件类型"], "progress");
  const state = firstField(fields, ["state", "status", "状态"], "running");
  const title = firstField(fields, ["title", "事件摘要", "标题"], eventKind);
  const detail = firstField(fields, ["detail", "详情", "说明", "事件详情"], title);
  return {
    id: firstField(fields, ["event_id", "事件ID"], record.record_id),
    recordId: record.record_id,
    taskId,
    runId: firstField(fields, ["run_id", "运行ID"]),
    agentId: firstField(fields, ["agent_id", "Agent ID"], "agent"),
    agentName: firstField(fields, ["agent_name", "Agent 名称", "Agent"], "Agent"),
    kind: eventKind,
    category: /artifact|产物/.test(eventKind.toLowerCase()) ? "artifact" : /report|日报/.test(eventKind.toLowerCase()) ? "report" : /incident|故障|failure/.test(eventKind.toLowerCase()) ? "incident" : "event",
    title,
    detail,
    status: state,
    occurredAt: timestamp(fields.occurred_at ?? fields["发生时间"] ?? fields["创建时间"], fallbackTime),
    artifactUrl: firstField(fields, ["artifact_url", "产物链接", "链接"]) || null,
  };
}

function feedbackSignal(record, fallbackTime) {
  const fields = record.fields ?? {};
  const kind = kindForFeedback(fields);
  const title = firstField(fields, ["标题", "问题", "需求", "body"], "未命名反馈");
  const body = firstField(fields, ["body", "内容", "详情", "需求描述"], title);
  const reply = firstField(fields, ["reply", "回复", "处理回复"]);
  return {
    id: firstField(fields, ["message_id", "消息ID"], record.record_id),
    recordId: record.record_id,
    taskId: firstField(fields, ["task_id", "任务ID", "任务 id"]),
    runId: firstField(fields, ["run_id", "运行ID"]),
    agentId: firstField(fields, ["agent_id", "Agent ID"], "agent"),
    agentName: firstField(fields, ["agent_name", "Agent 名称", "Agent"], "Agent"),
    kind,
    category: kind === "question" ? "question" : "feedback",
    title,
    detail: reply ? `${body}\n回复：${reply}` : body,
    reply,
    status: firstField(fields, ["status", "状态"], "pending"),
    occurredAt: timestamp(fields.created_at ?? fields["创建时间"], fallbackTime),
    artifactUrl: null,
  };
}

function receiptSignal(record, fallbackTime) {
  const fields = record.fields ?? {};
  const title = firstField(fields, ["产物名", "标题", "receipt"], "未命名产物／回执");
  const receipt = firstField(fields, ["receipt", "回执", "内容", "详情"], title);
  return {
    id: firstField(fields, ["receipt_id", "回执ID"], record.record_id),
    receiptId: firstField(fields, ["receipt_id", "回执ID"], record.record_id),
    recordId: record.record_id,
    taskId: firstField(fields, ["task_id", "任务ID", "任务 id"]),
    runId: firstField(fields, ["run_id", "运行ID"]),
    agentId: firstField(fields, ["agent_id", "Agent ID"], "agent"),
    agentName: firstField(fields, ["agent_name", "Agent 名称", "Agent"], "Agent"),
    kind: "receipt",
    category: "receipt",
    title,
    detail: receipt,
    status: firstField(fields, ["status", "状态"], "submitted"),
    occurredAt: timestamp(fields.acknowledged_at ?? fields.submitted_at ?? fields["创建时间"], fallbackTime),
    artifactUrl: firstField(fields, ["artifact_url", "产物链接", "链接"]) || null,
  };
}

export function projectFreshBase(snapshot, now = Date.now()) {
  const projectByRecordId = new Map();
  const projectByPublicId = new Map();
  for (const record of snapshot.projects ?? []) {
    const fields = record.fields ?? {};
    const publicId = firstField(fields, ["project_id", "项目ID", "项目 id"]);
    const projectName = firstField(fields, ["项目名", "项目名称", "项目", "标题"]);
    if (!publicId && !projectName) continue;
    const id = publicId || record.record_id;
    const name = projectName || "未命名项目";
    const project = {
      id,
      recordId: record.record_id,
      code: firstField(fields, ["项目代号", "代号"], id.slice(0, 18)),
      name,
      shortName: firstField(fields, ["简称", "项目简称"], name),
      goal: firstField(fields, ["目标", "项目目标", "说明"], "等待补充目标"),
      due: firstField(fields, ["截止", "截止日期", "due"], "持续"),
      accent: firstField(fields, ["强调色", "颜色"], accentFor(id)),
      tasks: [],
    };
    projectByRecordId.set(record.record_id, project);
    projectByPublicId.set(id, project);
  }

  const unfiled = { id: "unfiled", code: "OPS", name: "未归档", shortName: "未归档", goal: "仍需补齐项目关联", due: "持续", accent: "#687184", tasks: [] };
  for (const record of snapshot.tasks ?? []) {
    const fields = record.fields ?? {};
    const publicId = firstField(fields, ["task_id", "任务ID", "任务 id"]);
    const taskTitle = firstField(fields, ["任务名", "任务", "标题"]);
    if (!publicId && !taskTitle) continue;
    const id = publicId || record.record_id;
    const projectId = taskProjectId(fields, projectByRecordId, projectByPublicId);
    const project = projectByPublicId.get(projectId) ?? unfiled;
    const ownerText = firstField(fields, ["负责人", "执行者", "谁在干", "owner"], "我");
    const priority = firstField(fields, ["优先级", "priority"]);
    const stage = taskStage(fields);
    project.tasks.push({
      recordId: record.record_id,
      id,
      title: taskTitle || "未命名任务",
      done: stage === "done",
      stage,
      version: 0,
      writable: false,
      owner: /agent|codex|claude|jarvis|机器人/i.test(ownerText) ? "Agent" : /一起|共同/.test(ownerText) ? "一起" : "我",
      priority: /high|p0|紧急|高/.test(priority.toLowerCase()) ? "high" : "normal",
      relation: firstField(fields, ["下一步", "说明", "关系", "状态说明"], stage === "open" ? "待处理" : fieldText(stage)),
    });
  }
  if (unfiled.tasks.length) projectByPublicId.set(unfiled.id, unfiled);

  const eventRows = (snapshot.events ?? []).filter((record) => hasAnyField(record.fields, ["event_id", "事件ID", "task_id", "任务ID", "title", "事件摘要", "detail", "详情"]));
  const feedbackRows = (snapshot.feedback ?? []).filter((record) => hasAnyField(record.fields, ["message_id", "消息ID", "task_id", "任务ID", "标题", "问题", "需求", "body", "内容"]));
  const receiptRows = (snapshot.receipts ?? []).filter((record) => hasAnyField(record.fields, ["receipt_id", "回执ID", "task_id", "任务ID", "产物名", "标题", "receipt", "回执", "artifact_url", "产物链接"]));

  const signals = [
    ...eventRows.map((record, index) => eventSignal(record, now - index)),
    ...feedbackRows.map((record, index) => feedbackSignal(record, now - index)),
    ...receiptRows.map((record, index) => receiptSignal(record, now - index)),
  ].sort((a, b) => b.occurredAt - a.occurredAt);

  const byRun = new Map();
  for (const signal of signals.filter((item) => item.category === "event" || item.category === "artifact" || item.category === "report" || item.category === "incident")) {
    const runId = signal.runId || `${signal.agentId}:${signal.taskId}`;
    const bucket = byRun.get(runId) ?? [];
    bucket.push(signal);
    byRun.set(runId, bucket);
  }
  const runs = [...byRun.entries()].map(([runId, items]) => {
    const ordered = items.slice().sort((a, b) => a.occurredAt - b.occurredAt);
    const latest = ordered.at(-1);
    const receipt = signals.find((item) => item.category === "receipt" && item.taskId === latest.taskId && (!item.runId || item.runId === runId));
    const artifact = ordered.findLast((item) => item.category === "artifact" || item.artifactUrl) ?? receipt;
    const name = latest.agentName || latest.agentId || "Agent";
    return {
      id: runId,
      agentId: latest.agentId || "agent",
      agentName: name,
      agentMark: name.trim().slice(0, 2).toUpperCase() || "AI",
      agentAccent: agentAccent(latest.agentId || name),
      projectId: "",
      taskId: latest.taskId,
      stage: runStage(latest.status),
      status: latest.title,
      eta: latest.occurredAt ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(latest.occurredAt)) : "已记录",
      events: ordered.map((item) => ({
        time: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(item.occurredAt)),
        label: item.title,
        detail: item.detail,
      })),
      artifact: artifact ? { title: artifact.title, summary: artifact.detail, kind: artifact.category === "receipt" ? "BASE RECEIPT" : "AGENT ARTIFACT", url: artifact.artifactUrl } : undefined,
    };
  });

  const messages = feedbackRows.map((record, index) => {
    const signal = feedbackSignal(record, now - index);
    const kind = signal.kind;
    return {
      message_id: signal.id,
      task_id: signal.taskId,
      record_id: record.record_id,
      run_id: signal.runId || null,
      agent_id: signal.agentId,
      direction: kind === "question" ? "to_max" : "to_agent",
      kind,
      body: signal.detail,
      in_reply_to: null,
      status: messageStatus(signal.status),
      created_by: kind === "question" ? signal.agentName : "当前用户",
      created_at: signal.occurredAt,
    };
  });

  const agentReceipts = receiptRows.map((record, index) => {
    const signal = receiptSignal(record, now - index);
    return {
      receipt_id: signal.receiptId,
      subject_type: "message",
      subject_id: firstField(record.fields ?? {}, ["message_id", "消息ID"], signal.id),
      agent_id: signal.agentId,
      kind: signal.status,
      created_at: signal.occurredAt,
    };
  });

  return {
    projects: [...projectByPublicId.values()],
    runs,
    signals,
    messages,
    agentReceipts,
  };
}
