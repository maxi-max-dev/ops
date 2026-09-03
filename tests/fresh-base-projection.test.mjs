import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { projectFreshBase, resolveFreshTables } from "../worker/fresh-base.mjs";

test("requires an explicit fresh Base URL without a tenant-specific fallback", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const functionBody = source.match(/function freshBaseUrl\(env: Env\) \{[\s\S]*?\n\}/)?.[0];

  assert.ok(functionBody, "freshBaseUrl must remain present in the worker");
  assert.match(functionBody, /env\.MAXOPS_FRESH_BASE_URL\?\.trim\(\)/);
  assert.match(functionBody, /if \(!value\) throw new Error\("Missing MAXOPS_FRESH_BASE_URL"\)/);
  assert.doesNotMatch(functionBody, /feishu\.cn|MAXOPS_FRESH_BASE_APP_TOKEN/);
});

test("resolves the five fresh-copy business tables without treating views as sources", () => {
  const resolved = resolveFreshTables([
    { table_id: "tbl-projects", name: "项目" },
    { table_id: "tbl-tasks", name: "任务" },
    { table_id: "tbl-events", name: "Agent 事件" },
    { table_id: "tbl-feedback", name: "问题／反馈" },
    { table_id: "tbl-receipts", name: "产物 / 回执" },
  ]);
  assert.deepEqual(resolved.missing, []);
  assert.equal(resolved.tables.feedback.table_id, "tbl-feedback");
  assert.equal(resolved.tables.receipts.table_id, "tbl-receipts");
});

test("projects real Base rows into a task room with Agent updates, feedback, artifacts, and receipts", () => {
  const result = projectFreshBase({
    projects: [{ record_id: "rec-project", fields: { "项目名": "OPS 首次真实使用", project_id: "PRJ-FIRST", "目标": "亲自完成第一遍闭环" } }],
    tasks: [{ record_id: "rec-task", fields: { "任务名": "完成 OPS 第一遍真实闭环", task_id: "TASK-FIRST", project_id: "PRJ-FIRST", "五态": "进行中", "负责人": "Codex" } }],
    events: [
      { record_id: "rec-event-progress", fields: { event_id: "EVT-1", task_id: "TASK-FIRST", agent_id: "codex", agent_name: "Codex", run_id: "RUN-1", kind: "progress", state: "running", title: "完成数据核验", detail: "已读取 fresh copy", occurred_at: 1000 } },
      { record_id: "rec-event-artifact", fields: { event_id: "EVT-2", task_id: "TASK-FIRST", agent_id: "codex", agent_name: "Codex", run_id: "RUN-1", kind: "artifact", state: "done", title: "验收说明", detail: "产物已回写", artifact_url: "https://example.com/artifact", occurred_at: 2000 } },
    ],
    feedback: [{ record_id: "rec-feedback", fields: { message_id: "MSG-1", task_id: "TASK-FIRST", agent_id: "codex", type: "requirement", status: "claimed", "标题": "B需求：把第一次试用压缩成 3 步", body: "不要填写机器字段", created_at: 1500 } }],
    receipts: [{ record_id: "rec-receipt", fields: { receipt_id: "RCPT-1", task_id: "TASK-FIRST", agent_id: "codex", run_id: "RUN-1", status: "acknowledged", "产物名": "闭环回执", receipt: "finish 已确认", acknowledged_at: 2500 } }],
  }, 3000);

  assert.equal(result.projects[0].id, "PRJ-FIRST");
  assert.equal(result.projects[0].tasks[0].id, "TASK-FIRST");
  assert.equal(result.projects[0].tasks[0].writable, false);
  assert.equal(result.runs[0].taskId, "TASK-FIRST");
  assert.equal(result.runs[0].artifact.title, "验收说明");
  assert.deepEqual(result.signals.map((signal) => signal.category), ["receipt", "artifact", "feedback", "event"]);
  assert.equal(result.messages[0].body, "不要填写机器字段");
  assert.equal(result.agentReceipts[0].receipt_id, "RCPT-1");
});

test("ignores copied Base placeholder rows instead of rendering fake unnamed work", () => {
  const result = projectFreshBase({
    projects: [
      { record_id: "rec-project", fields: { "项目名": "真实项目", project_id: "PRJ-1" } },
      { record_id: "rec-empty-project", fields: { "项目名": null, project_id: null } },
    ],
    tasks: [
      { record_id: "rec-task", fields: { "任务名": "真实任务", task_id: "TASK-1", project_id: "PRJ-1" } },
      { record_id: "rec-empty-task", fields: {} },
    ],
    events: [{ record_id: "rec-empty-event", fields: {} }],
    feedback: [{ record_id: "rec-empty-feedback", fields: {} }],
    receipts: [{ record_id: "rec-empty-receipt", fields: {} }],
  });

  assert.deepEqual(result.projects.map((project) => project.name), ["真实项目"]);
  assert.deepEqual(result.projects[0].tasks.map((task) => task.title), ["真实任务"]);
  assert.equal(result.signals.length, 0);
  assert.equal(result.messages.length, 0);
  assert.equal(result.agentReceipts.length, 0);
});
