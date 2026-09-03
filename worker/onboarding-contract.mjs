const TEXT = (name, description) => ({ name, type: 1, uiType: "Text", description });
const DATE = (name) => ({ name, type: 5, uiType: "DateTime" });
const CHECKBOX = (name) => ({ name, type: 7, uiType: "Checkbox" });
const URL = (name) => ({ name, type: 15, uiType: "Url" });
const SELECT = (name, options) => ({
  name,
  type: 3,
  uiType: "SingleSelect",
  options: options.map((option, index) => ({ name: option, color: index % 8 })),
});

export const MAXOPS_PORTABLE_TEMPLATE_VERSION = "maxops-portable-base/1";

/**
 * This manifest is the public, portable layer. It intentionally contains no
 * tenant locator, Feishu credential, person identifier, or OPS operator
 * data. Runtime identities are injected only after the user authorizes their
 * own Base.
 */
export const MAXOPS_PORTABLE_TEMPLATE = Object.freeze({
  schemaVersion: MAXOPS_PORTABLE_TEMPLATE_VERSION,
  name: "OPS · 我的 Agent 工作台",
  timeZone: "Asia/Shanghai",
  tables: [
    {
      key: "projects",
      name: "项目",
      defaultView: "项目",
      fields: [
        TEXT("项目名", "给人看的项目名称"), TEXT("project_id"), TEXT("instance_id"),
        SELECT("状态", ["进行中", "等待", "完成", "暂停"]), TEXT("目标"), TEXT("负责人"),
        DATE("开始时间"), DATE("目标日期"), TEXT("进度"), TEXT("强调色"),
      ],
      views: [{ name: "项目详情", type: "grid" }],
    },
    {
      key: "tasks",
      name: "任务",
      defaultView: "今天",
      fields: [
        TEXT("任务名", "给人看的任务名称"), TEXT("task_id"), TEXT("instance_id"), TEXT("project_id"),
        TEXT("项目"), SELECT("五态", ["待办", "进行中", "等外部", "完成", "放弃"]),
        SELECT("优先级", ["高", "普通", "低"]), CHECKBOX("今日"), TEXT("负责人"), TEXT("来源"),
        TEXT("原因"), DATE("started_at"), DATE("due_at"), DATE("completed_at"), URL("artifact_url"),
        TEXT("receipt"), DATE("updated_at"),
      ],
      views: [{ name: "项目", type: "kanban" }],
    },
    {
      key: "events",
      name: "Agent 事件",
      defaultView: "动态",
      fields: [
        TEXT("事件摘要"), TEXT("任务"), TEXT("event_id"), TEXT("instance_id"), TEXT("task_id"),
        TEXT("idempotency_key"), TEXT("payload_digest"), TEXT("agent_id"), TEXT("agent_name"),
        TEXT("run_id"), TEXT("kind"), TEXT("state"), TEXT("status"), TEXT("title"), TEXT("detail"),
        URL("artifact_url"), DATE("occurred_at"), CHECKBOX("已读"),
      ],
      views: [],
    },
    {
      key: "feedback",
      name: "问题／反馈",
      defaultView: "问题",
      fields: [
        TEXT("标题"), TEXT("任务"), TEXT("message_id"), TEXT("instance_id"), TEXT("task_id"),
        TEXT("agent_id"), TEXT("run_id"), TEXT("type"), TEXT("status"), TEXT("状态展示"), TEXT("body"),
        TEXT("reply"), TEXT("来源"), TEXT("原因"), DATE("created_at"), DATE("replied_at"),
      ],
      views: [],
    },
    {
      key: "receipts",
      name: "产物／回执",
      defaultView: "产物与回执",
      fields: [
        TEXT("产物名"), TEXT("任务"), TEXT("receipt_id"), TEXT("artifact_id"), TEXT("instance_id"),
        TEXT("task_id"), TEXT("idempotency_key"), TEXT("payload_digest"), TEXT("message_id"), TEXT("agent_id"),
        TEXT("run_id"), TEXT("type"), TEXT("status"), TEXT("状态展示"), URL("artifact_url"), TEXT("receipt"),
        TEXT("提交者"), TEXT("说明"), DATE("submitted_at"), DATE("acknowledged_at"),
      ],
      views: [],
    },
  ],
  portableCapabilities: {
    tables: "provisioned_by_api",
    fields: "provisioned_by_api",
    views: "provisioned_by_api",
    sampleRecords: "provisioned_by_api",
    nativeAppMode: "requires_second_tenant_canary",
    aiAgent: "requires_second_tenant_canary",
    automations: "requires_second_tenant_canary",
    permissions: "requires_second_tenant_canary",
  },
});

export function normalizePortableAgentName(value) {
  if (typeof value !== "string") return "我的 Agent";
  const name = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return name || "我的 Agent";
}

export function materializePortableRecords({ instanceId, projectId, taskId, now = Date.now() }) {
  if (![instanceId, projectId, taskId].every((value) => typeof value === "string" && value.length >= 12)) {
    throw new Error("Portable record identities are required");
  }
  return {
    projects: [{
      "项目名": "第一次连接 OPS",
      project_id: projectId,
      instance_id: instanceId,
      "状态": "进行中",
      "目标": "让一个本地 Agent 读到测试任务，并把真实进度写回这份 Base",
      "负责人": "我和 Agent",
      "开始时间": now,
      "进度": "0%",
      "强调色": "#315bd6",
    }],
    tasks: [{
      "任务名": "连接测试",
      task_id: taskId,
      instance_id: instanceId,
      project_id: projectId,
      "项目": "第一次连接 OPS",
      "五态": "待办",
      "优先级": "高",
      "今日": true,
      "负责人": "待配对 Agent",
      "来源": "OPS 一键安装器",
      "原因": "用于验证 Base、漂亮看板与本地 Agent 读取的是同一条任务",
      updated_at: now,
    }],
    events: [],
    feedback: [],
    receipts: [],
  };
}

export function assertPortableTemplateSafe(value, extraForbidden = []) {
  const serialized = JSON.stringify(value);
  const forbidden = [
    "/Users/", "app_secret", "app_token", "table_id_value", "instance_id_value",
    "open_id", "tenant_access_token", "user_access_token", "PRIVATE_BASE_SENTINEL", "cli_", ...extraForbidden,
  ];
  const hit = forbidden.find((needle) => needle && serialized.includes(needle));
  if (hit) throw new Error(`Portable template contains forbidden material: ${hit}`);
  return true;
}

export function portableCanaryMatrix() {
  return [
    ["五张业务表", "LOCAL_PROVISIONER_VERIFIED"],
    ["字段", "LOCAL_PROVISIONER_VERIFIED"],
    ["今天／项目／动态／项目详情视图", "LOCAL_PROVISIONER_VERIFIED"],
    ["脱敏连接测试记录", "LOCAL_PROVISIONER_VERIFIED"],
    ["应用模式", "UNAVAILABLE_SECOND_TENANT"],
    ["飞书 AI Agent", "UNAVAILABLE_SECOND_TENANT"],
    ["自动化", "UNAVAILABLE_SECOND_TENANT"],
    ["跨租户权限", "UNAVAILABLE_SECOND_TENANT"],
  ].map(([surface, status]) => ({ surface, status }));
}

export function buildPortableTableCreatePayload(table) {
  if (!table || typeof table.name !== "string" || !Array.isArray(table.fields)) throw new Error("Invalid portable table");
  return {
    table: {
      name: table.name,
      default_view_name: table.defaultView,
      fields: table.fields.map((field) => ({
        field_name: field.name,
        type: field.type,
        ...(field.uiType ? { ui_type: field.uiType } : {}),
        ...(field.options ? { property: { options: field.options } } : {}),
        ...(field.description ? { description: { text: field.description } } : {}),
      })),
    },
  };
}

export function validatePortableDiscovery(discovered) {
  const tables = discovered && typeof discovered === "object" ? discovered : {};
  for (const table of MAXOPS_PORTABLE_TEMPLATE.tables) {
    const fields = tables[table.name];
    if (!Array.isArray(fields)) throw new Error(`Missing portable table: ${table.name}`);
    const names = new Set(fields);
    for (const field of table.fields) if (!names.has(field.name)) throw new Error(`Missing portable field: ${table.name}.${field.name}`);
  }
  return true;
}
