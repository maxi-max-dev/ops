import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

class D1StatementHarness {
  constructor(owner, sql, bindings = []) {
    this.owner = owner;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) { return new D1StatementHarness(this.owner, this.sql, bindings); }
  async run() {
    if (this.owner.failFailedEvents > 0 && this.sql.includes("INSERT OR IGNORE INTO events") && this.bindings[3] === "failed") {
      this.owner.failFailedEvents -= 1;
      throw new Error("injected failed event failure");
    }
    if (this.owner.failNotificationFailureStatusUpdates > 0 && this.sql.includes("UPDATE notification_outbox SET status = 'failed'")) {
      this.owner.failNotificationFailureStatusUpdates -= 1;
      throw new Error("injected notification status failure");
    }
    if (this.owner.failProjectionRunUpdates > 0 && this.sql.includes("UPDATE runs SET status = 'projection_inflight'")) {
      this.owner.failProjectionRunUpdates -= 1;
      throw new Error("injected projection run update failure");
    }
    if (this.owner.failModelResolvedEvents > 0 && this.sql.includes("INSERT OR IGNORE INTO events") && this.bindings[3] === "model_resolved") {
      this.owner.failModelResolvedEvents -= 1;
      throw new Error("injected model event failure");
    }
    if (this.owner.failApprovedGateInserts > 0 && this.sql.includes("INSERT INTO gates") && this.sql.includes("'approved'")) {
      this.owner.failApprovedGateInserts -= 1;
      throw new Error("injected approved gate insert failure");
    }
    const result = this.owner.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }
  async first() { return this.owner.database.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.owner.database.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
}

class D1Harness {
  constructor(database) {
    this.database = database;
    this.failFinalizeBatches = 0;
    this.failGateApprovalBatches = 0;
    this.failFailedEvents = 0;
    this.failNotificationFailureStatusUpdates = 0;
    this.failProjectionRunUpdates = 0;
    this.failModelResolvedEvents = 0;
    this.failApprovedGateInserts = 0;
    this.failRoutingClaimBatches = 0;
    this.crashAfterProjectionAcquireCommits = 0;
    this.crashAfterGateCancelCommits = 0;
  }

  prepare(sql) { return new D1StatementHarness(this, sql); }
  async batch(statements) {
    if (this.failFinalizeBatches > 0 && statements.some((statement) => statement.sql.includes("UPDATE receipts SET status = 'succeeded'"))) {
      this.failFinalizeBatches -= 1;
      throw new Error("injected finalize batch failure");
    }
    if (this.failGateApprovalBatches > 0 && statements.some((statement) => statement.sql.includes("gate_reply_received")) && statements.some((statement) => statement.sql.includes("status = 'confirmed'"))) {
      this.failGateApprovalBatches -= 1;
      throw new Error("injected gate approval batch failure");
    }
    if (this.failRoutingClaimBatches > 0 && statements.some((statement) => statement.sql.includes("processing_stage = 'routing'"))) {
      this.failRoutingClaimBatches -= 1;
      throw new Error("injected routing claim batch failure");
    }
    const crashAfterProjectionAcquire = this.crashAfterProjectionAcquireCommits > 0
      && statements.some((statement) => statement.sql.includes("status = 'projection_inflight'") && statement.sql.includes("projection_lease_until"));
    const crashAfterGateCancel = this.crashAfterGateCancelCommits > 0
      && statements.some((statement) => statement.sql.includes("status = 'cancelled'"))
      && statements.some((statement) => statement.bindings[3] === "gate_cancelled");
    this.database.exec("BEGIN IMMEDIATE");
    let results;
    try {
      results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (crashAfterProjectionAcquire) {
      this.crashAfterProjectionAcquireCommits -= 1;
      throw new Error("injected isolate termination after projection acquire commit");
    }
    if (crashAfterGateCancel) {
      this.crashAfterGateCancelCommits -= 1;
      throw new Error("injected isolate termination after gate cancel commit");
    }
    return results;
  }
}

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of ["0000_good_junta.sql", "0001_calm_lady_bullseye.sql", "0002_far_alex_wilder.sql", "0003_durable_projection_lease.sql", "0004_fenced_projection_outbox.sql", "0005_projection_recovery_lease.sql", "0006_collaboration_source.sql", "0007_task_stage.sql", "0008_agent_api.sql", "0009_agent_scope_fingerprints.sql"]) {
    const sql = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) database.exec(statement);
  }
  return database;
}

function seedCommand(database, { commandId, runId, targetState, expectedVersion }) {
  database.prepare(`INSERT INTO commands
    (command_id, idempotency_key, source, actor_hash, raw_input, intent, task_id, record_id, target_state, confidence, reason, status,
     expected_version, run_id, model_provider, attempts, created_at, updated_at, confirmed_at)
    VALUES (?, ?, 'h5', 'actor', ?, 'task_state_update', 'task-1', 'record-1', ?, 1, 'test', 'confirmed', ?, ?, 'direct_human_gate', 0, 1, 1, 1)`)
    .run(commandId, `idem-${commandId}`, commandId, targetState, expectedVersion, runId);
  database.prepare("INSERT INTO runs (run_id, command_id, status, provider, started_at) VALUES (?, ?, 'confirmed', 'direct_human_gate', 1)")
    .run(runId, commandId);
}

function projectionEnv(db) {
  return {
    DB: db,
    FEISHU_SERVICE_APP_ID: "dummy-app",
    FEISHU_SERVICE_APP_SECRET: "dummy-secret",
    FEISHU_BASE_APP_TOKEN: "dummy-base",
    FEISHU_TABLE_ID: "dummy-table",
    FEISHU_H5_APP_ID: "dummy-bot",
    FEISHU_H5_APP_SECRET: "dummy-bot-secret",
    PROJECTION_LEASE_MS: "100",
  };
}

function installFeishuProjectionFetch(remote, onPut, botMessages = []) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      botMessages.push(JSON.parse(JSON.parse(String(init.body)).content).text);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1") && init.method === "PUT") {
      const fields = JSON.parse(String(init.body)).fields;
      await onPut(fields);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) {
      return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "完成": remote.done, "更新来源": remote.source } } } });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  return () => { globalThis.fetch = original; };
}

async function openIdHash(openId) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(openId));
  return Buffer.from(digest).toString("base64url");
}

async function sessionCookie(openId, secret = "bot-secret") {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`max-ops-session:${secret}`));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify({ openId, name: "Test", exp: Date.now() + 60_000 }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));
  const encode = (bytes) => Buffer.from(bytes).toString("base64url");
  return `max_ops_feishu=${encode(nonce)}.${encode(ciphertext)}`;
}

async function encryptedRecipient(openId, secret = "bot-secret") {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`max-ops-session:${secret}`));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(openId)));
  return `${Buffer.from(nonce).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
}

async function durableNotificationId(commandId, kind) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${commandId}:${kind}`));
  return `ntf_${Buffer.from(digest).toString("base64url").slice(0, 40)}`;
}

function feishuMessage(messageId, openId, text) {
  return {
    header: { token: "event-token", event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: openId }, sender_type: "user" },
      message: { message_id: messageId, message_type: "text", content: JSON.stringify({ text }), chat_type: "p2p" },
    },
  };
}

function webhookEnv(db, allowedHash) {
  return {
    DB: db,
    FEISHU_EVENT_VERIFICATION_TOKEN: "event-token",
    FEISHU_ALLOWED_OPEN_ID_HASHES: allowedHash,
    FEISHU_SERVICE_APP_ID: "service-app",
    FEISHU_SERVICE_APP_SECRET: "service-secret",
    FEISHU_BASE_APP_TOKEN: "base-app",
    FEISHU_TABLE_ID: "table-1",
    FEISHU_H5_APP_ID: "bot-app",
    FEISHU_H5_APP_SECRET: "bot-secret",
    OPENAI_API_KEY: "test-openai-key",
    COMMAND_PROCESSING_LEASE_MS: "100",
    PROJECTION_LEASE_MS: "100",
    NOTIFICATION_LEASE_MS: "100",
    NOTIFICATION_SEND_TIMEOUT_MS: "100",
  };
}

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the personal multi-project work OS", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>OPS · Personal Work OS<\/title>/i);
  assert.match(html, /正在进行/);
  assert.match(html, /仍有进行项/);
  assert.match(html, /集中查看/);
  assert.match(html, /最值得推进/);
  assert.match(html, /所有进行项/);
  assert.match(html, /谁在做什么/);
  assert.match(html, /不把“在线”当成进度/);
  assert.match(html, /汇总 20 条用户访谈/);
  assert.match(html, /这件事的对话/);
  assert.match(html, /发布页先把哪一个放在第一屏/);
  assert.match(html, /等我回复/);
  assert.match(html, /接入飞书数据与 Agent/);
  assert.match(html, /Base 是唯一真源/);
  assert.match(html, /最近更新记录/);
  assert.doesNotMatch(html, /拍板|任务星图|驾驶台/);
  assert.doesNotMatch(html, /AI 产品岗求职|升学与长期规划|家庭事务/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/);
});

test("keeps completed work in a dedicated collection", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /tab === "completed"/);
  assert.match(source, /做完的事集中放这里/);
  assert.match(source, /返回今天/);
});

test("renders the read-only UI lab for visual iteration", async () => {
  const response = await render("/ui-lab");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /同一套工作结构，三种使用深度/);
  assert.match(html, /没有 Agent，也完整成立/);
  assert.match(html, /Agent 更新进入原任务/);
  assert.match(html, /反馈闭环有证据/);
  assert.match(html, /不触碰飞书、D1 或写回合同/);
});

test("agent run stops at the human review gate", async () => {
  const { advanceRun } = await import("../app/agent-loop.mjs");
  const run = {
    stage: "running",
    step: 1,
    status: "继续执行",
    events: [],
  };

  const advanced = advanceRun(run);
  assert.equal(advanced.step, 2);
  assert.equal(advanced.stage, "review");
  assert.equal(advanced.status, "结果待你拍板");
  assert.equal(advanced.artifact.kind, "执行结果");
  assert.match(advanced.events.at(-1).detail, /人工拍板门/);
});

test("voice intent updates known tasks and archives ambiguous speech", async () => {
  const { interpretVoice } = await import("../app/voice-command.mjs");
  const tasks = [
    {
      id: "signup",
      title: "完成比赛报名",
      done: false,
      projectId: "hack",
      projectName: "黑客松",
    },
    {
      id: "resume",
      title: "提交下一份定制简历",
      done: false,
      projectId: "career",
      projectName: "求职",
    },
  ];

  assert.deepEqual(
    interpretVoice("我刚刚把报名报完了", tasks).taskId,
    "signup",
  );
  assert.deepEqual(
    interpretVoice("简历已经递交完了", tasks).taskId,
    "resume",
  );
  assert.equal(interpretVoice("我又发现了一些新东西", tasks).kind, "capture");
});

test("Feishu gate replies are protocol messages, not an AI fallback", async () => {
  const { continueApprovedGate, normalizeDecision, parseFeishuText, parseGateReply, processingLeaseMs, shouldResumeQueuedCommand } = await import("../worker/command-core.mjs");
  assert.equal(parseFeishuText('{"text":"  黑客松报名已经收尾  "}'), "黑客松报名已经收尾");
  assert.deepEqual(parseGateReply("确认 cmd_12345678-abcd"), { action: "confirm", commandId: "cmd_12345678-abcd" });
  assert.equal(parseGateReply("报名已经完成"), null);

  const tasks = [{ id: "wr-4", title: "完成比赛报名" }];
  assert.equal(normalizeDecision({ intent: "task_state_update", entity: "wr-4", target_state: "done", confidence: 0.93, reason: "语义匹配" }, tasks).entity, "wr-4");
  assert.equal(normalizeDecision({ intent: "task_state_update", entity: "made-up", target_state: "done", confidence: 0.99, reason: "不存在" }, tasks).intent, "unknown");

  let executed = false;
  let notifyFailureRecorded = false;
  await continueApprovedGate({
    notifyStart: async () => { throw new Error("bot unavailable"); },
    recordNotifyFailure: async () => { notifyFailureRecorded = true; },
    execute: async () => { executed = true; },
  });
  assert.equal(notifyFailureRecorded, true);
  assert.equal(executed, true);

  executed = false;
  await continueApprovedGate({
    notifyStart: async () => { throw new Error("bot unavailable"); },
    recordNotifyFailure: async () => { throw new Error("event ledger unavailable"); },
    execute: async () => { executed = true; },
  });
  assert.equal(executed, true);
  assert.equal(shouldResumeQueuedCommand({ status: "queued" }), true);
  assert.equal(shouldResumeQueuedCommand({ status: "needs_confirmation" }), false);
  assert.equal(processingLeaseMs(undefined), 5_000);
  assert.ok(processingLeaseMs(undefined) <= 5_000, "production takeover must reserve at least 25 seconds of the waitUntil budget");
});

test("Feishu live data is not persisted as static demo state", async () => {
  const { canMutateStaticDemo, clearLiveClientStorage, DEMO_STORAGE_KEY, failedSyncBoundary, LEGACY_STORAGE_KEYS, mutationRefreshCopy, persistStaticDemo, shouldRestoreStaticDemoOnUnauth, unauthenticatedDemoState } = await import("../app/live-boundary.mjs");
  const values = new Map([[DEMO_STORAGE_KEY, JSON.stringify({ projects: [{ title: "真实私密任务" }], runs: [{ id: "real-run" }] })], ...LEGACY_STORAGE_KEYS.map((key) => [key, "real"])]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  persistStaticDemo(storage, "feishu", { projects: [{ title: "另一个真实任务" }], runs: [{ id: "real-run-2" }] });
  clearLiveClientStorage(storage);
  assert.equal(values.size, 0);
  persistStaticDemo(storage, "feishu_syncing", { projects: [{ title: "同步中的真实任务" }], runs: [{ id: "live-run-syncing" }] });
  assert.equal(values.size, 0);
  const fallback = unauthenticatedDemoState([{ id: "demo", title: "固定演示任务" }], [{ id: "demo-run" }], "固定演示事件");
  assert.equal(fallback.lastReceipt, null);
  assert.deepEqual(fallback.captures, []);
  persistStaticDemo(storage, "local", fallback);
  const unauthenticatedDom = storage.getItem(DEMO_STORAGE_KEY);
  assert.match(unauthenticatedDom, /固定演示任务/);
  assert.doesNotMatch(unauthenticatedDom, /真实私密任务|另一个真实任务|real-run/);

  const partial = mutationRefreshCopy(false, { run_id: "run-ok", receipt_id: "rct-ok" });
  assert.equal(partial.complete, false);
  assert.match(partial.detail, /星图刷新失败/);
  assert.doesNotMatch(partial.event, /已关联|四方状态已刷新/);
  assert.equal(canMutateStaticDemo("local"), true);
  assert.equal(canMutateStaticDemo("error"), false);
  assert.equal(canMutateStaticDemo("connecting"), false);
  assert.equal(canMutateStaticDemo("feishu"), false);
  assert.equal(canMutateStaticDemo("feishu_syncing"), false);
  assert.equal(shouldRestoreStaticDemoOnUnauth(404, "error", false), true);
  assert.equal(shouldRestoreStaticDemoOnUnauth(404, "local", false), false);
  assert.equal(shouldRestoreStaticDemoOnUnauth(401, "local", false), true);
  assert.deepEqual(failedSyncBoundary("error", false), { restore: true, mode: "error" });
  assert.deepEqual(failedSyncBoundary("feishu", false), { restore: true, mode: "error" });
  assert.deepEqual(failedSyncBoundary("feishu_syncing", false), { restore: true, mode: "error" });
  assert.deepEqual(failedSyncBoundary("connecting", false), { restore: false, mode: "local" });
});

test("failed ledger entries render as failures, never human gates", async () => {
  const { ledgerPresentation } = await import("../worker/command-core.mjs");
  const failed = ledgerPresentation("failed", "Base unavailable", "rct-failed");
  assert.equal(failed.stage, "failed");
  assert.equal(failed.artifactKind, "FAILURE RECEIPT");
  assert.doesNotMatch(failed.artifactKind, /HUMAN GATE/);
  const unknown = ledgerPresentation("superseded_unknown", "marker evidence lost", "rct-unknown");
  assert.equal(unknown.stage, "failed");
  assert.equal(unknown.artifactKind, "UNVERIFIED PROJECTION");
  assert.doesNotMatch(unknown.artifactKind, /FAILURE RECEIPT|HUMAN GATE/);
});

test("D1 ledger rejects duplicate commands and delayed stale writes", async () => {
  const database = await migratedDatabase();

  const insertCommand = database.prepare(`INSERT INTO commands
    (command_id, idempotency_key, source, actor_hash, raw_input, status, run_id, attempts, created_at, updated_at)
    VALUES (?, ?, 'h5', 'actor', 'toggle', 'confirmed', ?, 0, 1, 1)`);
  insertCommand.run("cmd-a", "same-key", "run-a");
  assert.throws(() => insertCommand.run("cmd-b", "same-key", "run-b"), /UNIQUE constraint failed/);

  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  const claim = database.prepare("UPDATE task_entities SET state = ?, version = version + 1, causation_id = ? WHERE task_id = ? AND version = ?");
  assert.equal(claim.run(1, "cmd-a", "task-1", 0).changes, 1);
  assert.equal(claim.run(0, "cmd-newer", "task-1", 1).changes, 1);
  assert.equal(claim.run(1, "cmd-delayed", "task-1", 0).changes, 0);
  assert.deepEqual({ ...database.prepare("SELECT state, version, causation_id FROM task_entities WHERE task_id = 'task-1'").get() }, { state: 0, version: 2, causation_id: "cmd-newer" });
  database.close();
});

test("a fresh Feishu edit invalidates a stale D1 projection before Base write", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, stage, version, updated_at) VALUES ('task-1', 'record-1', 0, 'open', 0, 1)").run();
  seedCommand(database, { commandId: "cmd-stale-feishu", runId: "run-stale-feishu", targetState: "done", expectedVersion: 0 });
  const remote = { done: true, source: "User manual edit" };
  let putCount = 0;
  const restoreFetch = installFeishuProjectionFetch(remote, async () => { putCount += 1; });
  try {
    const { executeCommand } = await import(`../dist/server/index.js?stale-feishu=${Date.now()}`);
    await assert.rejects(() => executeCommand(projectionEnv(d1), "cmd-stale-feishu"), /Stale entity version/);
    assert.equal(putCount, 0);
    assert.deepEqual(
      { ...database.prepare("SELECT state, stage, version, causation_id FROM task_entities WHERE task_id = 'task-1'").get() },
      { state: 1, stage: "done", version: 1, causation_id: "feishu:manual-sync" },
    );
    assert.equal(database.prepare("SELECT status FROM commands WHERE command_id = 'cmd-stale-feishu'").get().status, "failed");
  } finally {
    restoreFetch();
    database.close();
  }
});

test("a stale Feishu list snapshot cannot roll back a concurrent confirmed write", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  const openId = "ou-snapshot-fence";
  const env = { ...webhookEnv(d1, await openIdHash(openId)), FEISHU_TASK_SCHEMA: "war_board" };
  const remote = { stage: "🚧进行中", note: "原备注" };
  let releaseList;
  let markListStarted;
  const listReleased = new Promise((resolve) => { releaseList = resolve; });
  const listStarted = new Promise((resolve) => { markListStarted = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) return Response.json({ code: 0, data: { message_id: "om-snapshot-fence" } });
    if (url.includes("/records/record-1") && init.method === "PUT") {
      const fields = JSON.parse(String(init.body)).fields;
      remote.stage = String(fields["阶段"]);
      remote.note = String(fields["备注"]);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) {
      return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { "任务": "并发验收", "项目": "基建", "阶段": remote.stage, "备注": remote.note } } } });
    }
    if (url.includes("/records")) {
      const staleStage = remote.stage;
      const staleNote = remote.note;
      markListStarted();
      await listReleased;
      return Response.json({ code: 0, data: { items: [{ record_id: "record-1", fields: { "任务": "并发验收", "项目": "基建", "阶段": staleStage, "备注": staleNote } }], has_more: false } });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?snapshot-fence=${Date.now()}`, import.meta.url).href);
    const context = { waitUntil(promise) { promise.catch(() => {}); }, passThroughOnException() {} };
    const cookie = await sessionCookie(openId);
    const statePromise = worker.fetch(new Request("http://localhost/api/feishu/state", { headers: { cookie } }), env, context);
    await listStarted;

    const mutation = await worker.fetch(new Request("http://localhost/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ taskId: "record-1", recordId: "record-1", targetState: "waiting", expectedVersion: 0, idempotencyKey: "snapshot-fence-command-0001", label: "把并发验收改为等外部" }),
    }), env, context);
    assert.equal(mutation.status, 200);
    assert.equal(remote.stage, "⏳等外部");

    releaseList();
    const state = await statePromise;
    assert.equal(state.status, 200);
    const stateJson = await state.json();
    assert.equal(stateJson.projects[0].tasks[0].stage, "waiting");
    assert.deepEqual(
      { ...database.prepare("SELECT stage, version, causation_id FROM task_entities WHERE task_id = 'record-1'").get() },
      { stage: "waiting", version: 1, causation_id: database.prepare("SELECT command_id FROM commands").get().command_id },
    );
    assert.equal(remote.stage, "⏳等外部");
    assert.doesNotMatch(remote.note, /持久台账恢复/);
  } finally {
    releaseList?.();
    globalThis.fetch = original;
    database.close();
  }
});

test("Agent API keeps distinct record_id/task_id and closes a non-Codex lifecycle with idempotent receipts", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  const openId = "ou-agent-loop";
  const remote = { stage: "🚧进行中", note: "" };
  const env = {
    ...webhookEnv(d1, await openIdHash(openId)),
    FEISHU_TASK_SCHEMA: "war_board",
    MAXOPS_AGENT_TOKEN: "agent-test-token",
    MAXOPS_AGENT_ALLOW_GLOBAL_TOKEN: "true",
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/records/record-1") && init.method === "PUT") {
      const fields = JSON.parse(String(init.body)).fields;
      remote.note = String(fields["备注"] ?? remote.note);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) {
      return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "任务": "OPS 收口", "项目": "基建", "阶段": remote.stage, "备注": remote.note } } } });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?agent-loop=${Date.now()}`, import.meta.url).href);
    const context = { waitUntil() {}, passThroughOnException() {} };
    const agentHeaders = { authorization: "Bearer agent-test-token", "content-type": "application/json", "Idempotency-Key": "self-proof-event-0001" };
    const taskRead = await worker.fetch(new Request("http://localhost/api/agent/v1/tasks/record-1", {
      headers: { authorization: "Bearer agent-test-token" },
    }), env, context);
    assert.equal(taskRead.status, 200);
    const taskReadJson = await taskRead.json();
    assert.equal(taskReadJson.source, "feishu");
    assert.deepEqual(taskReadJson.task, {
      task_id: "task-1",
      record_id: "record-1",
      title: "OPS 收口",
      stage: "running",
      owner: "我",
      priority: "normal",
      relation: "未分类",
    });
    assert.equal(remote.note, "");

    const unscopedEvent = await worker.fetch(new Request("http://localhost/api/agent/v1/events", {
      method: "POST",
      headers: { ...agentHeaders, "Idempotency-Key": "self-proof-unscoped-0001" },
      body: JSON.stringify({ agent_id: "future-agent", agent_name: "Future Agent", run_id: "future-agent:run-self-proof", kind: "progress", state: "running", title: "不应入账", detail: "缺少任务身份。" }),
    }), env, context);
    assert.equal(unscopedEvent.status, 400);
    assert.equal((await unscopedEvent.json()).error, "task_id must be a string");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_events").get().count, 0);

    const eventBody = JSON.stringify({ agent_id: "future-agent", agent_name: "Future Agent", run_id: "future-agent:run-self-proof", task_id: "task-1", record_id: "record-1", kind: "progress", state: "running", title: "本地回归已绿", detail: "Agent API 事件真实入账。" });
    const firstEvent = await worker.fetch(new Request("http://localhost/api/agent/v1/events", { method: "POST", headers: agentHeaders, body: eventBody }), env, context);
    assert.equal(firstEvent.status, 201);
    const firstEventJson = await firstEvent.json();
    const duplicateEvent = await worker.fetch(new Request("http://localhost/api/agent/v1/events", { method: "POST", headers: agentHeaders, body: eventBody }), env, context);
    assert.equal(duplicateEvent.status, 200);
    assert.equal((await duplicateEvent.json()).receipt.receipt_id, firstEventJson.receipt.receipt_id);
    const conflictingEvent = await worker.fetch(new Request("http://localhost/api/agent/v1/events", {
      method: "POST",
      headers: agentHeaders,
      body: eventBody.replace("Agent API 事件真实入账。", "同一个键却换了载荷。"),
    }), env, context);
    assert.equal(conflictingEvent.status, 409);
    assert.equal((await conflictingEvent.json()).error, "Idempotency payload conflict");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_events").get().count, 1);
    assert.deepEqual(
      { ...database.prepare("SELECT task_id, record_id FROM agent_events").get() },
      { task_id: "task-1", record_id: "record-1" },
    );

    const question = await worker.fetch(new Request("http://localhost/api/agent/v1/questions", {
      method: "POST",
      headers: { ...agentHeaders, "Idempotency-Key": "self-proof-question-0001" },
      body: JSON.stringify({ agent_id: "future-agent", agent_name: "Future Agent", run_id: "future-agent:run-self-proof", task_id: "task-1", record_id: "record-1", question: "请确认下一步按真实飞书闭环验收。" }),
    }), env, context);
    assert.equal(question.status, 201);
    const questionJson = await question.json();

    const reply = await worker.fetch(new Request("http://localhost/api/feishu/instructions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await sessionCookie(openId), "Idempotency-Key": "max-reply-0000000001" },
      body: JSON.stringify({ task_id: "task-1", record_id: "record-1", run_id: "future-agent:run-self-proof", agent_id: "future-agent", body: "确认，继续真实闭环验收。", in_reply_to: questionJson.message.message_id }),
    }), env, context);
    assert.equal(reply.status, 201);
    const replyJson = await reply.json();
    assert.match(remote.note, new RegExp(`MAXOPS-MSG:${replyJson.message.message_id}`));
    assert.equal(database.prepare("SELECT status FROM agent_messages WHERE message_id = ?").get(questionJson.message.message_id).status, "answered");

    const inbox = await worker.fetch(new Request("http://localhost/api/agent/v1/inbox?agent_id=future-agent&run_id=future-agent%3Arun-self-proof&task_id=task-1&record_id=record-1", {
      headers: { authorization: "Bearer agent-test-token" },
    }), env, context);
    assert.equal(inbox.status, 200);
    const inboxJson = await inbox.json();
    assert.deepEqual(inboxJson.messages.map((message) => message.message_id), [replyJson.message.message_id]);

    const receiptUrl = `http://localhost/api/agent/v1/messages/${replyJson.message.message_id}/receipts`;
    const receiptHeaders = { authorization: "Bearer agent-test-token", "content-type": "application/json", "Idempotency-Key": "agent-ack-0000000001" };
    const receiptBody = JSON.stringify({ agent_id: "future-agent", kind: "acknowledged" });
    const acknowledgement = await worker.fetch(new Request(receiptUrl, { method: "POST", headers: receiptHeaders, body: receiptBody }), env, context);
    assert.equal(acknowledgement.status, 201);
    const acknowledgementJson = await acknowledgement.json();
    assert.equal(acknowledgementJson.message.status, "acknowledged");
    assert.equal(acknowledgementJson.receipt.before.status, "pending");
    assert.equal(acknowledgementJson.receipt.after.status, "acknowledged");

    const duplicateAck = await worker.fetch(new Request(receiptUrl, { method: "POST", headers: receiptHeaders, body: receiptBody }), env, context);
    assert.equal(duplicateAck.status, 200);
    assert.equal((await duplicateAck.json()).receipt.receipt_id, acknowledgementJson.receipt.receipt_id);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_receipts").get().count, 4);
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("Agent task credentials fail closed instead of falling through to global or ingest tokens", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  const scopedToken = "task-scoped-agent-token";
  const env = {
    ...webhookEnv(d1, await openIdHash("ou-agent-scope")),
    FEISHU_TASK_SCHEMA: "war_board",
    MAXOPS_AGENT_TASK_CREDENTIALS_JSON: JSON.stringify([{
      token_sha256: await openIdHash(scopedToken),
      agent_id: "future-agent",
      task_id: "task-1",
      record_id: "record-1",
    }]),
    MAXOPS_AGENT_TOKEN: "broader-global-token",
    MAXOPS_AGENT_ALLOW_GLOBAL_TOKEN: "true",
    MAXOPS_INGEST_TOKEN: "unrelated-ingest-token",
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/records/record-1")) return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "任务": "任务级凭据验收", "项目": "基建", "阶段": "🚧进行中" } } } });
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?agent-scope=${Date.now()}`, import.meta.url).href);
    const context = { waitUntil() {}, passThroughOnException() {} };
    for (const rejected of ["broader-global-token", "unrelated-ingest-token"]) {
      const response = await worker.fetch(new Request("http://localhost/api/agent/v1/health", { headers: { authorization: `Bearer ${rejected}` } }), env, context);
      assert.equal(response.status, 401);
    }
    const ingestOnly = { ...env, MAXOPS_AGENT_TASK_CREDENTIALS_JSON: undefined, MAXOPS_AGENT_TOKEN: undefined, MAXOPS_AGENT_ALLOW_GLOBAL_TOKEN: undefined };
    const ingestFallback = await worker.fetch(new Request("http://localhost/api/agent/v1/health", { headers: { authorization: "Bearer unrelated-ingest-token" } }), ingestOnly, context);
    assert.equal(ingestFallback.status, 401);
    const unflaggedGlobal = await worker.fetch(new Request("http://localhost/api/agent/v1/health", { headers: { authorization: "Bearer broader-global-token" } }), {
      ...ingestOnly,
      MAXOPS_AGENT_TOKEN: "broader-global-token",
    }, context);
    assert.equal(unflaggedGlobal.status, 401);
    const read = await worker.fetch(new Request("http://localhost/api/agent/v1/tasks/record-1", { headers: { authorization: `Bearer ${scopedToken}` } }), env, context);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).task.task_id, "task-1");

    const denied = await worker.fetch(new Request("http://localhost/api/agent/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${scopedToken}`, "content-type": "application/json", "Idempotency-Key": "scope-denied-0000001" },
      body: JSON.stringify({ agent_id: "another-agent", agent_name: "Other", run_id: "scope-run", task_id: "task-1", record_id: "record-1", kind: "progress", state: "running", title: "越权", detail: "不得写入" }),
    }), env, context);
    assert.equal(denied.status, 403);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_events").get().count, 0);
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("Base success followed by ledger failure replays without a second PUT", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.failFinalizeBatches = 1;
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-same", runId: "run-same", targetState: "done", expectedVersion: 0 });
  const remote = { done: false, source: "manual" };
  let putCount = 0;
  const restoreFetch = installFeishuProjectionFetch(remote, async (fields) => {
    putCount += 1;
    remote.done = Boolean(fields["完成"]);
    remote.source = String(fields["更新来源"]);
  });
  try {
    const { executeCommand } = await import(`../dist/server/index.js?projection=${Date.now()}`);
    const first = await executeCommand(projectionEnv(d1), "cmd-same");
    const replay = await executeCommand(projectionEnv(d1), "cmd-same");
    assert.equal(putCount, 1);
    assert.equal(first.receipt_id, replay.receipt_id);
    assert.equal(first.status, "succeeded");
    assert.match(remote.source, new RegExp(`${first.run_id}.*${first.receipt_id}`));
    assert.deepEqual({ ...database.prepare("SELECT state, version, causation_id FROM task_entities WHERE task_id = 'task-1'").get() }, { state: 1, version: 1, causation_id: "cmd-same" });
  } finally {
    restoreFetch();
    database.close();
  }
});

test("war-board projection writes abandon stage and an auditable Feishu remark", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, stage, version, updated_at) VALUES ('task-1', 'record-1', 0, 'running', 0, 1)").run();
  seedCommand(database, { commandId: "cmd-abandon", runId: "run-abandon", targetState: "abandoned", expectedVersion: 0 });
  const remote = { stage: "🚧进行中", note: "原备注" };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/records/record-1") && init.method === "PUT") {
      const fields = JSON.parse(String(init.body)).fields;
      remote.stage = String(fields["阶段"]);
      remote.note = String(fields["备注"]);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "阶段": remote.stage, "备注": remote.note } } } });
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { executeCommand } = await import(`../dist/server/index.js?war-board=${Date.now()}`);
    const receipt = await executeCommand({ ...projectionEnv(d1), FEISHU_TASK_SCHEMA: "war_board" }, "cmd-abandon");
    assert.equal(receipt.status, "succeeded");
    assert.equal(remote.stage, "🛑放弃");
    assert.match(remote.note, /进行中→放弃/);
    assert.match(remote.note, /原因：test/);
    assert.match(remote.note, /用户说“cmd-abandon”/);
    assert.match(remote.note, /run-abandon.*rct_/);
    assert.deepEqual({ ...database.prepare("SELECT state, stage, version FROM task_entities WHERE task_id = 'task-1'").get() }, { state: 0, stage: "abandoned", version: 1 });
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("concurrent failed projection never rolls entity version back or splits Base", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-A", runId: "run-A", targetState: "done", expectedVersion: 0 });
  const remote = { done: false, source: "manual" };
  let releaseA;
  let enteredA;
  const aEntered = new Promise((resolve) => { enteredA = resolve; });
  const holdA = new Promise((resolve) => { releaseA = resolve; });
  let failedB = false;
  const restoreFetch = installFeishuProjectionFetch(remote, async (fields) => {
    const source = String(fields["更新来源"]);
    if (source.includes("run-A")) {
      remote.done = Boolean(fields["完成"]);
      remote.source = source;
      enteredA();
      await holdA;
      return;
    }
    if (source.includes("run-B") && !failedB) {
      failedB = true;
      throw new Error("injected B Base failure");
    }
    remote.done = Boolean(fields["完成"]);
    remote.source = source;
  });
  try {
    const { executeCommand } = await import(`../dist/server/index.js?concurrent=${Date.now()}`);
    const runA = executeCommand(projectionEnv(d1), "cmd-A");
    await aEntered;
    seedCommand(database, { commandId: "cmd-B", runId: "run-B", targetState: "open", expectedVersion: 1 });
    await assert.rejects(() => executeCommand(projectionEnv(d1), "cmd-B", undefined, 1), /recoverable after 1 checks/);
    releaseA();
    await runA;
    await executeCommand(projectionEnv(d1), "cmd-B");

    assert.deepEqual({ ...database.prepare("SELECT state, version, causation_id FROM task_entities WHERE task_id = 'task-1'").get() }, { state: 0, version: 2, causation_id: "cmd-B" });
    assert.equal(remote.done, false);
    assert.match(remote.source, /run-B.*rct_/);
    assert.deepEqual(database.prepare("SELECT command_id, status FROM commands ORDER BY command_id").all().map((row) => ({ ...row })), [{ command_id: "cmd-A", status: "succeeded" }, { command_id: "cmd-B", status: "succeeded" }]);
    assert.deepEqual(database.prepare("SELECT command_id, status FROM receipts ORDER BY command_id").all().map((row) => ({ ...row })), [{ command_id: "cmd-A", status: "succeeded" }, { command_id: "cmd-B", status: "succeeded" }]);
  } finally {
    releaseA?.();
    restoreFetch();
    database.close();
  }
});

test("orphaned projection recovers across independent invocations with one successful mutation", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-orphan", runId: "run-orphan", targetState: "done", expectedVersion: 0 });
  const remote = { done: false, source: "manual" };
  let putAttempts = 0;
  let successfulMutations = 0;
  const restoreFetch = installFeishuProjectionFetch(remote, async (fields) => {
    putAttempts += 1;
    if (putAttempts === 1) throw new Error("injected Base transport failure");
    successfulMutations += 1;
    remote.done = Boolean(fields["完成"]);
    remote.source = String(fields["更新来源"]);
  });
  try {
    const { executeCommand } = await import(`../dist/server/index.js?orphan=${Date.now()}`);
    await assert.rejects(() => executeCommand(projectionEnv(d1), "cmd-orphan", undefined, 1), /recoverable after 1 checks/);
    const pending = database.prepare("SELECT status, receipt_id FROM commands WHERE command_id = 'cmd-orphan'").get();
    assert.equal(pending.status, "projection_prepared");
    assert.match(pending.receipt_id, /^rct_/);
    assert.equal(database.prepare("SELECT status FROM receipts WHERE command_id = 'cmd-orphan'").get().status, "projection_pending");

    const recovered = await executeCommand(projectionEnv(d1), "cmd-orphan");
    assert.equal(recovered.receipt_id, pending.receipt_id);
    assert.equal(recovered.status, "succeeded");
    assert.equal(putAttempts, 2);
    assert.equal(successfulMutations, 1);
    assert.equal(remote.done, true);
    assert.match(remote.source, new RegExp(`run-orphan.*${pending.receipt_id}`));
    assert.deepEqual({ ...database.prepare("SELECT state, version, causation_id FROM task_entities WHERE task_id = 'task-1'").get() }, { state: 1, version: 1, causation_id: "cmd-orphan" });
  } finally {
    restoreFetch();
    database.close();
  }
});

test("projection command and run acquisition roll back atomically before any Base PUT", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.failProjectionRunUpdates = 1;
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-acquire", runId: "run-acquire", targetState: "done", expectedVersion: 0 });
  const remote = { done: false, source: "manual" };
  let puts = 0;
  const restoreFetch = installFeishuProjectionFetch(remote, async (fields) => {
    puts += 1;
    remote.done = Boolean(fields["完成"]);
    remote.source = String(fields["更新来源"]);
  });
  try {
    const { executeCommand } = await import(`../dist/server/index.js?atomic-acquire=${Date.now()}`);
    await assert.rejects(() => executeCommand(projectionEnv(d1), "cmd-acquire", undefined, 1), /injected projection run update failure/);
    const pending = database.prepare("SELECT status, projection_token, receipt_id FROM commands WHERE command_id = 'cmd-acquire'").get();
    assert.equal(pending.status, "projection_prepared");
    assert.equal(pending.projection_token, null);
    assert.match(pending.receipt_id, /^rct_/);
    assert.equal(database.prepare("SELECT status FROM runs WHERE run_id = 'run-acquire'").get().status, "projection_prepared");
    assert.equal(puts, 0);

    const receipt = await executeCommand(projectionEnv(d1), "cmd-acquire");
    assert.equal(receipt.receipt_id, pending.receipt_id);
    assert.equal(receipt.status, "succeeded");
    assert.equal(puts, 1);
    assert.equal(remote.done, true);
  } finally {
    restoreFetch();
    database.close();
  }
});

test("expired projection acquisition survives an isolate crash after the source-truth preflight read", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.crashAfterProjectionAcquireCommits = 1;
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-acquire-crash", runId: "run-acquire-crash", targetState: "done", expectedVersion: 0 });
  const env = projectionEnv(d1);
  const original = globalThis.fetch;
  const remote = { done: false, source: "manual" };
  let gets = 0;
  let puts = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/records/record-1") && init.method === "PUT") {
      puts += 1;
      const fields = JSON.parse(String(init.body)).fields;
      remote.done = Boolean(fields["完成"]);
      remote.source = String(fields["更新来源"]);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) {
      gets += 1;
      return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "完成": remote.done, "更新来源": remote.source } } } });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const moduleUrl = new URL(`../dist/server/index.js?projection-acquire-crash=${Date.now()}`, import.meta.url).href;
    const { default: worker, executeCommand } = await import(moduleUrl);
    await assert.rejects(() => executeCommand(env, "cmd-acquire-crash", undefined, 1), /isolate termination/);
    const orphan = database.prepare("SELECT status, projection_token, projection_lease_until, receipt_id FROM commands WHERE command_id = 'cmd-acquire-crash'").get();
    assert.equal(orphan.status, "projection_inflight");
    assert.match(orphan.projection_token, /^projection_/);
    assert.ok(orphan.projection_lease_until > Date.now());
    assert.match(orphan.receipt_id, /^rct_/);
    assert.equal(gets, 1);
    assert.equal(puts, 0);

    await new Promise((resolve) => setTimeout(resolve, 120));
    let recoveryWork;
    await worker.scheduled({}, env, { waitUntil(promise) { recoveryWork = promise; } });
    await recoveryWork;

    assert.equal(puts, 1);
    assert.equal(remote.done, true);
    assert.equal(database.prepare("SELECT status FROM commands WHERE command_id = 'cmd-acquire-crash'").get().status, "succeeded");
    assert.equal(database.prepare("SELECT status FROM runs WHERE run_id = 'run-acquire-crash'").get().status, "succeeded");
    assert.deepEqual({ ...database.prepare("SELECT state, version, causation_id FROM task_entities WHERE task_id = 'task-1'").get() }, { state: 1, version: 1, causation_id: "cmd-acquire-crash" });
    assert.deepEqual({ ...database.prepare("SELECT receipt_id, status FROM receipts WHERE command_id = 'cmd-acquire-crash'").get() }, { receipt_id: orphan.receipt_id, status: "succeeded" });
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("superseded successful projection finalizes truthfully without overwriting the newer version", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.failFinalizeBatches = 1;
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-old", runId: "run-old", targetState: "done", expectedVersion: 0 });
  const remote = { done: false, source: "manual" };
  let putCount = 0;
  const botMessages = [];
  const restoreFetch = installFeishuProjectionFetch(remote, async (fields) => {
    putCount += 1;
    remote.done = Boolean(fields["完成"]);
    remote.source = String(fields["更新来源"]);
  }, botMessages);
  try {
    const { executeCommand } = await import(`../dist/server/index.js?superseded=${Date.now()}`);
    await assert.rejects(() => executeCommand(projectionEnv(d1), "cmd-old", undefined, 1), /recoverable after 1 checks/);
    const oldReceipt = database.prepare("SELECT receipt_id FROM commands WHERE command_id = 'cmd-old'").get().receipt_id;

    seedCommand(database, { commandId: "cmd-new", runId: "run-new", targetState: "open", expectedVersion: 1 });
    await executeCommand(projectionEnv(d1), "cmd-new");
    await executeCommand(projectionEnv(d1), "cmd-old", "ou-history");

    assert.equal(putCount, 2);
    assert.equal(remote.done, false);
    assert.match(remote.source, /run-new.*rct_/);
    assert.deepEqual({ ...database.prepare("SELECT state, version, causation_id FROM task_entities WHERE task_id = 'task-1'").get() }, { state: 0, version: 2, causation_id: "cmd-new" });
    assert.deepEqual(database.prepare("SELECT command_id, status FROM commands ORDER BY command_id").all().map((row) => ({ ...row })), [{ command_id: "cmd-new", status: "succeeded" }, { command_id: "cmd-old", status: "succeeded" }]);
    assert.equal(database.prepare("SELECT receipt_id, status FROM receipts WHERE command_id = 'cmd-old'").get().receipt_id, oldReceipt);
    assert.equal(database.prepare("SELECT receipt_id, status FROM receipts WHERE command_id = 'cmd-old'").get().status, "succeeded");
    assert.equal(botMessages.length, 1);
    assert.match(botMessages[0], /历史写回已确认，随后被更新/);
    assert.match(botMessages[0], /当前状态：未完成 \(v2\)/);
  } finally {
    restoreFetch();
    database.close();
  }
});

test("delayed terminal success retry re-renders historical and current authoritative state", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-notify-A", runId: "run-notify-A", targetState: "done", expectedVersion: 0 });
  const env = { ...projectionEnv(d1), NOTIFICATION_LEASE_MS: "100", NOTIFICATION_SEND_TIMEOUT_MS: "100" };
  const remote = { done: false, source: "manual" };
  const original = globalThis.fetch;
  const delivered = [];
  const uuids = [];
  let firstATerminal = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      const body = JSON.parse(String(init.body));
      const text = JSON.parse(body.content).text;
      if (text.includes("run-notify-A") && firstATerminal) {
        firstATerminal = false;
        uuids.push(body.uuid);
        return Response.json({ code: 999, msg: "injected bot failure" });
      }
      uuids.push(body.uuid);
      delivered.push(text);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1") && init.method === "PUT") {
      const fields = JSON.parse(String(init.body)).fields;
      remote.done = Boolean(fields["完成"]);
      remote.source = String(fields["更新来源"]);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "完成": remote.done, "更新来源": remote.source } } } });
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const moduleUrl = new URL(`../dist/server/index.js?dynamic-success=${Date.now()}`, import.meta.url).href;
    const { default: worker, executeCommand } = await import(moduleUrl);
    const first = await executeCommand(env, "cmd-notify-A", "ou-dynamic-success");
    assert.equal(first.status, "succeeded");
    assert.equal(database.prepare("SELECT status FROM notification_outbox WHERE command_id = 'cmd-notify-A'").get().status, "failed");

    seedCommand(database, { commandId: "cmd-notify-B", runId: "run-notify-B", targetState: "open", expectedVersion: 1 });
    await executeCommand(env, "cmd-notify-B");
    let recoveryWork;
    await worker.scheduled({}, env, { waitUntil(promise) { recoveryWork = promise; } });
    await recoveryWork;

    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /历史写回已确认，随后被更新/);
    assert.match(delivered[0], /当前状态：未完成 \(v2\)/);
    assert.equal(uuids.length, 2);
    assert.equal(uuids[0], uuids[1]);
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("default retry exhaustion remains recoverable across a later invocation", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-exhaust", runId: "run-exhaust", targetState: "done", expectedVersion: 0 });
  const remote = { done: false, source: "manual" };
  let putAttempts = 0;
  let successfulMutations = 0;
  const restoreFetch = installFeishuProjectionFetch(remote, async (fields) => {
    putAttempts += 1;
    if (putAttempts <= 3) throw new Error("injected repeated transport failure");
    successfulMutations += 1;
    remote.done = Boolean(fields["完成"]);
    remote.source = String(fields["更新来源"]);
  });
  try {
    const { executeCommand } = await import(`../dist/server/index.js?exhaust=${Date.now()}`);
    await assert.rejects(() => executeCommand(projectionEnv(d1), "cmd-exhaust"), /recoverable after 3 checks/);
    const pending = database.prepare("SELECT status, attempts, receipt_id FROM commands WHERE command_id = 'cmd-exhaust'").get();
    assert.equal(pending.status, "projection_prepared");
    assert.equal(pending.attempts, 3);
    const recovered = await executeCommand(projectionEnv(d1), "cmd-exhaust");
    assert.equal(recovered.receipt_id, pending.receipt_id);
    assert.equal(recovered.status, "succeeded");
    assert.equal(putAttempts, 4);
    assert.equal(successfulMutations, 1);
    assert.equal(remote.done, true);
  } finally {
    restoreFetch();
    database.close();
  }
});

test("stale projection timestamp never lets a second owner PUT while the first is alive", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-live-owner", runId: "run-live-owner", targetState: "done", expectedVersion: 0 });
  const remote = { done: false, source: "manual" };
  let putCount = 0;
  let releasePut;
  let putEntered;
  const entered = new Promise((resolve) => { putEntered = resolve; });
  const held = new Promise((resolve) => { releasePut = resolve; });
  const restoreFetch = installFeishuProjectionFetch(remote, async (fields) => {
    putCount += 1;
    putEntered();
    await held;
    remote.done = Boolean(fields["完成"]);
    remote.source = String(fields["更新来源"]);
  });
  try {
    const { executeCommand } = await import(`../dist/server/index.js?live-owner=${Date.now()}`);
    const first = executeCommand(projectionEnv(d1), "cmd-live-owner");
    await entered;
    database.prepare("UPDATE commands SET updated_at = 0 WHERE command_id = 'cmd-live-owner'").run();
    await assert.rejects(() => executeCommand(projectionEnv(d1), "cmd-live-owner", undefined, 1), /still in flight/);
    assert.equal(putCount, 1);
    releasePut();
    const receipt = await first;
    assert.equal(receipt.status, "succeeded");
    assert.equal(putCount, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM receipts").get().count, 1);
  } finally {
    releasePut?.();
    restoreFetch();
    database.close();
  }
});

test("a pending predecessor is recovered before a newer version can claim the entity", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-unapplied", runId: "run-unapplied", targetState: "done", expectedVersion: 0 });
  const remote = { done: false, source: "manual" };
  let putAttempts = 0;
  const restoreFetch = installFeishuProjectionFetch(remote, async (fields) => {
    putAttempts += 1;
    if (putAttempts === 1) throw new Error("A was never applied");
    remote.done = Boolean(fields["完成"]);
    remote.source = String(fields["更新来源"]);
  });
  try {
    const { executeCommand } = await import(`../dist/server/index.js?unapplied=${Date.now()}`);
    await assert.rejects(() => executeCommand(projectionEnv(d1), "cmd-unapplied", undefined, 1), /recoverable after 1 checks/);
    const stableReceipt = database.prepare("SELECT receipt_id FROM commands WHERE command_id = 'cmd-unapplied'").get().receipt_id;
    seedCommand(database, { commandId: "cmd-after", runId: "run-after", targetState: "open", expectedVersion: 1 });
    await executeCommand(projectionEnv(d1), "cmd-after");
    await executeCommand(projectionEnv(d1), "cmd-unapplied");
    assert.equal(database.prepare("SELECT status FROM commands WHERE command_id = 'cmd-unapplied'").get().status, "succeeded");
    const receipt = database.prepare("SELECT receipt_id, status FROM receipts WHERE command_id = 'cmd-unapplied'").get();
    assert.equal(receipt.receipt_id, stableReceipt);
    assert.equal(receipt.status, "succeeded");
    assert.deepEqual({ ...database.prepare("SELECT state, version, causation_id FROM task_entities WHERE task_id = 'task-1'").get() }, { state: 0, version: 2, causation_id: "cmd-after" });
    assert.equal(remote.done, false);
    assert.match(remote.source, /run-after.*rct_/);
    assert.equal(putAttempts, 3);
  } finally {
    restoreFetch();
    database.close();
  }
});

test("lost applied evidence superseded by a forced newer version is reported unknown, never failed or succeeded", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  seedCommand(database, { commandId: "cmd-uncertain", runId: "run-uncertain", targetState: "done", expectedVersion: 0 });
  const remote = { done: false, source: "OPS · run-newer · rct-newer" };
  const botMessages = [];
  let putAttempts = 0;
  const restoreFetch = installFeishuProjectionFetch(remote, async () => {
    putAttempts += 1;
    throw new Error("first owner disappeared after an ambiguous write boundary");
  }, botMessages);
  try {
    const { executeCommand } = await import(`../dist/server/index.js?unknown=${Date.now()}`);
    await assert.rejects(() => executeCommand(projectionEnv(d1), "cmd-uncertain", undefined, 1), /recoverable after 1 checks/);
    const stableReceipt = database.prepare("SELECT receipt_id FROM commands WHERE command_id = 'cmd-uncertain'").get().receipt_id;
    database.prepare("UPDATE commands SET status = 'projection_inflight', projection_token = 'abandoned-owner' WHERE command_id = 'cmd-uncertain'").run();
    database.prepare("UPDATE task_entities SET state = 0, version = 2, causation_id = 'cmd-newer', updated_at = 2 WHERE task_id = 'task-1'").run();
    seedCommand(database, { commandId: "cmd-newer", runId: "run-newer", targetState: "open", expectedVersion: 1 });
    database.prepare("UPDATE commands SET status = 'succeeded', receipt_id = 'rct-newer', claimed_version = 2, completed_at = 2 WHERE command_id = 'cmd-newer'").run();
    database.prepare("UPDATE runs SET status = 'succeeded', completed_at = 2 WHERE run_id = 'run-newer'").run();
    database.prepare(`INSERT INTO receipts (receipt_id, command_id, run_id, status, task_id, entity_version, before_json, after_json, notification_status, created_at)
      VALUES ('rct-newer', 'cmd-newer', 'run-newer', 'succeeded', 'task-1', 2, '{"done":true}', '{"done":false}', 'not_requested', 2)`).run();

    const receipt = await executeCommand(projectionEnv(d1), "cmd-uncertain", "ou-unknown");
    assert.equal(receipt.receipt_id, stableReceipt);
    assert.equal(receipt.status, "superseded_unknown");
    assert.equal(database.prepare("SELECT status FROM commands WHERE command_id = 'cmd-uncertain'").get().status, "superseded_unknown");
    assert.equal(database.prepare("SELECT status FROM runs WHERE run_id = 'run-uncertain'").get().status, "superseded_unknown");
    assert.equal(putAttempts, 1);
    assert.equal(botMessages.length, 1);
    assert.match(botMessages[0], /历史投影无法确认/);
    assert.doesNotMatch(botMessages[0], /写回失败|已写回/);
  } finally {
    restoreFetch();
    database.close();
  }
});

test("duplicate Feishu delivery re-enqueues an ACKed queued command exactly once", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  const openId = "ou-requeue";
  const env = webhookEnv(d1, await openIdHash(openId));
  env.COMMAND_PROCESSING_LEASE_MS = "100";
  env.NOTIFICATION_SEND_TIMEOUT_MS = "500";
  const original = globalThis.fetch;
  let firstBotTokenDropped = false;
  const botMessages = [];
  const remote = { done: false, source: "manual" };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) {
      const body = JSON.parse(String(init.body));
      if (body.app_id === "bot-app" && !firstBotTokenDropped) {
        firstBotTokenDropped = true;
        return new Promise(() => {});
      }
      return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    }
    if (url.includes("/im/v1/messages")) {
      botMessages.push(JSON.parse(JSON.parse(String(init.body)).content).text);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records?page_size=200")) return Response.json({ code: 0, data: { items: [{ record_id: "record-1", fields: { task_id: "task-1", "任务": "真任务", "项目": "项目", "完成": false } }] } });
    if (url.includes("/records/record-1") && init.method === "PUT") {
      const fields = JSON.parse(String(init.body)).fields;
      remote.done = Boolean(fields["完成"]);
      remote.source = String(fields["更新来源"]);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "完成": remote.done, "更新来源": remote.source } } } });
    if (url === "https://api.openai.com/v1/responses") return Response.json({ id: "resp-requeue", output_text: JSON.stringify({ intent: "task_state_update", entity: "task-1", target_state: "done", confidence: 0.99, reason: "matched" }) });
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const workerUrl = new URL(`../dist/server/index.js?webhook-requeue=${Date.now()}`, import.meta.url);
    const { default: worker } = await import(workerUrl.href);
    const body = JSON.stringify(feishuMessage("msg-requeue", openId, "完成真任务"));
    let waitUntilCalls = 0;
    let firstWork;
    const first = await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body }), env, { waitUntil(promise) { waitUntilCalls += 1; firstWork = promise; } });
    assert.equal(first.status, 202);
    for (let attempt = 0; attempt < 50 && database.prepare("SELECT status FROM commands").get().status === "queued"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "processing");

    let replayWork;
    const replay = await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body }), env, { waitUntil(promise) { waitUntilCalls += 1; replayWork = promise; } });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).requeued, true);
    await replayWork;

    assert.equal(waitUntilCalls, 2);
    const queuedCommand = database.prepare("SELECT command_id, status FROM commands").get();
    assert.equal(queuedCommand.status, "needs_confirmation");
    assert.equal(database.prepare("SELECT count(*) AS count FROM commands").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM runs").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM gates").get().count, 1);
    assert.equal(botMessages.filter((message) => message.includes("请确认写回")).length, 1);
    await Promise.allSettled([firstWork]);

    let gateWork;
    const gate = await worker.fetch(new Request("http://localhost/api/feishu/events", {
      method: "POST",
      body: JSON.stringify(feishuMessage("msg-requeue-gate", openId, `确认 ${queuedCommand.command_id}`)),
    }), env, { waitUntil(promise) { gateWork = promise; } });
    assert.equal(gate.status, 202);
    await gateWork;
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "succeeded");
    assert.equal(database.prepare("SELECT count(*) AS count FROM receipts").get().count, 1);
    assert.equal(database.prepare("SELECT status FROM receipts").get().status, "succeeded");
    assert.equal(remote.done, true);
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("the durable scanner resumes a queued command after its first routing claim batch fails", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.failRoutingClaimBatches = 1;
  const openId = "ou-queued-scanner";
  const env = webhookEnv(d1, await openIdHash(openId));
  const original = globalThis.fetch;
  const delivered = [];
  let modelCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      delivered.push(JSON.parse(JSON.parse(String(init.body)).content).text);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records?page_size=200")) return Response.json({ code: 0, data: { items: [{ record_id: "record-1", fields: { task_id: "task-1", "任务": "排队恢复任务", "项目": "项目", "完成": false } }] } });
    if (url === "https://api.openai.com/v1/responses") {
      modelCalls += 1;
      return Response.json({ id: "resp-queued-scanner", output_text: JSON.stringify({ intent: "task_state_update", entity: "task-1", target_state: "done", confidence: 0.99, reason: "matched" }) });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?queued-scanner=${Date.now()}`, import.meta.url).href);
    let firstWork;
    const response = await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body: JSON.stringify(feishuMessage("msg-queued-scanner", openId, "完成排队恢复任务")) }), env, { waitUntil(promise) { firstWork = promise; } });
    assert.equal(response.status, 202);
    await assert.rejects(() => firstWork, /routing claim batch failure/);
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "queued");
    assert.equal(database.prepare("SELECT status FROM runs").get().status, "queued");
    assert.equal(database.prepare("SELECT count(*) AS count FROM notification_outbox WHERE kind = 'routing_received'").get().count, 1);

    let recoveryWork;
    await worker.scheduled({}, env, { waitUntil(promise) { recoveryWork = promise; } });
    await recoveryWork;
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "needs_confirmation");
    assert.equal(modelCalls, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM gates").get().count, 1);
    assert.equal(delivered.filter((message) => message.includes("已收到，正在用 AI")).length, 1);
    assert.equal(delivered.filter((message) => message.includes("请确认写回")).length, 1);
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("the durable scanner takes over expired routing without a duplicate delivery", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  const openId = "ou-routing-scanner";
  const env = webhookEnv(d1, await openIdHash(openId));
  delete env.COMMAND_PROCESSING_LEASE_MS;
  const original = globalThis.fetch;
  const delivered = [];
  let listCalls = 0;
  let modelCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      delivered.push(JSON.parse(JSON.parse(String(init.body)).content).text);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records?page_size=200")) {
      listCalls += 1;
      if (listCalls === 1) return new Promise(() => {});
      return Response.json({ code: 0, data: { items: [{ record_id: "record-1", fields: { task_id: "task-1", "任务": "路由恢复任务", "项目": "项目", "完成": false } }] } });
    }
    if (url === "https://api.openai.com/v1/responses") {
      modelCalls += 1;
      return Response.json({ id: "resp-routing-scanner", output_text: JSON.stringify({ intent: "task_state_update", entity: "task-1", target_state: "done", confidence: 0.99, reason: "matched" }) });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?routing-scanner=${Date.now()}`, import.meta.url).href);
    let firstWork;
    const response = await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body: JSON.stringify(feishuMessage("msg-routing-scanner", openId, "完成路由恢复任务")) }), env, { waitUntil(promise) { firstWork = promise; } });
    assert.equal(response.status, 202);
    for (let attempt = 0; attempt < 100 && listCalls === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(listCalls, 1);
    assert.equal(database.prepare("SELECT status, processing_stage FROM commands").get().status, "processing");
    assert.equal(database.prepare("SELECT processing_stage FROM commands").get().processing_stage, "routing");

    await new Promise((resolve) => setTimeout(resolve, 5_100));
    let recoveryWork;
    await worker.scheduled({}, env, { waitUntil(promise) { recoveryWork = promise; } });
    await recoveryWork;
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "needs_confirmation");
    assert.equal(modelCalls, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM gates").get().count, 1);
    assert.equal(delivered.filter((message) => message.includes("已收到，正在用 AI")).length, 1);
    assert.equal(delivered.filter((message) => message.includes("请确认写回")).length, 1);
    void firstWork;
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("terminal failed Gate sends one receipt-bearing failure and never a pending claim", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.failFailedEvents = 1;
  const openId = "ou-stale-gate";
  const actor = await openIdHash(openId);
  const env = webhookEnv(d1, actor);
  seedCommand(database, { commandId: "cmd_deadbeef", runId: "run-stale-gate", targetState: "done", expectedVersion: 0 });
  database.prepare("UPDATE commands SET status = 'needs_confirmation', actor_hash = ? WHERE command_id = 'cmd_deadbeef'").run(actor);
  database.prepare("UPDATE runs SET status = 'needs_confirmation' WHERE run_id = 'run-stale-gate'").run();
  database.prepare("INSERT INTO gates (gate_id, command_id, status, before_json, after_json, requested_at) VALUES ('gate-stale', 'cmd_deadbeef', 'pending', '{}', '{}', 1)").run();
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, causation_id, updated_at) VALUES ('task-1', 'record-1', 1, 1, 'newer-command', 2)").run();
  const original = globalThis.fetch;
  const botMessages = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      botMessages.push(JSON.parse(JSON.parse(String(init.body)).content).text);
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const workerUrl = new URL(`../dist/server/index.js?stale-gate=${Date.now()}`, import.meta.url);
    const { default: worker } = await import(workerUrl.href);
    let gateWork;
    const response = await worker.fetch(new Request("http://localhost/api/feishu/events", {
      method: "POST",
      body: JSON.stringify(feishuMessage("msg-stale-gate", openId, "确认 cmd_deadbeef")),
    }), env, { waitUntil(promise) { gateWork = promise; } });
    assert.equal(response.status, 202);
    await gateWork;

    const receipt = database.prepare("SELECT receipt_id, status, notification_status FROM receipts WHERE command_id = 'cmd_deadbeef'").get();
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.notification_status, "sent");
    const failures = botMessages.filter((message) => message.includes("写回失败"));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /run-stale-gate/);
    assert.match(failures[0], new RegExp(receipt.receipt_id));
    assert.equal(botMessages.some((message) => message.includes("持久恢复队列")), false);
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("terminal failure notification recovers after both delivery and outbox-status faults", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.failNotificationFailureStatusUpdates = 1;
  const openId = "ou-failure-outbox";
  const actor = await openIdHash(openId);
  const env = webhookEnv(d1, actor);
  seedCommand(database, { commandId: "cmd_fa11baaa", runId: "run-failbox", targetState: "done", expectedVersion: 0 });
  database.prepare("UPDATE commands SET status = 'needs_confirmation', actor_hash = ? WHERE command_id = 'cmd_fa11baaa'").run(actor);
  database.prepare("UPDATE runs SET status = 'needs_confirmation' WHERE run_id = 'run-failbox'").run();
  database.prepare("INSERT INTO gates (gate_id, command_id, status, before_json, after_json, requested_at) VALUES ('gate-failbox', 'cmd_fa11baaa', 'pending', '{}', '{}', 1)").run();
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, causation_id, updated_at) VALUES ('task-1', 'record-1', 1, 1, 'newer', 2)").run();
  const original = globalThis.fetch;
  const delivered = [];
  let failureAttempts = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      const text = JSON.parse(JSON.parse(String(init.body)).content).text;
      if (text.includes("写回失败")) {
        failureAttempts += 1;
        if (failureAttempts === 1) return new Response("unavailable", { status: 503 });
      }
      delivered.push(text);
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?failure-outbox=${Date.now()}`, import.meta.url).href);
    let work;
    await worker.fetch(new Request("http://localhost/api/feishu/events", {
      method: "POST",
      body: JSON.stringify(feishuMessage("msg-failbox", openId, "确认 cmd_fa11baaa")),
    }), env, { waitUntil(promise) { work = promise; } });
    await work;

    const receipt = database.prepare("SELECT receipt_id, status, notification_status FROM receipts WHERE command_id = 'cmd_fa11baaa'").get();
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.notification_status, "sent");
    assert.equal(failureAttempts, 2);
    assert.equal(delivered.filter((message) => message.includes("写回失败")).length, 1);
    assert.match(delivered.at(-1), new RegExp(receipt.receipt_id));
    assert.equal(database.prepare("SELECT status FROM notification_outbox WHERE kind = 'terminal_failure'").get().status, "sent");
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("concurrent duplicate Feishu delivery holds one processing lease and one terminal receipt", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  const openId = "ou-concurrent-message";
  const env = webhookEnv(d1, await openIdHash(openId));
  const original = globalThis.fetch;
  const botMessages = [];
  const remote = { done: false, source: "manual" };
  let modelCalls = 0;
  let releaseModel;
  let modelEntered;
  const entered = new Promise((resolve) => { modelEntered = resolve; });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      botMessages.push(JSON.parse(JSON.parse(String(init.body)).content).text);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records?page_size=200")) return Response.json({ code: 0, data: { items: [{ record_id: "record-1", fields: { task_id: "task-1", "任务": "并发真任务", "项目": "项目", "完成": false } }] } });
    if (url.includes("/records/record-1") && init.method === "PUT") {
      const fields = JSON.parse(String(init.body)).fields;
      remote.done = Boolean(fields["完成"]);
      remote.source = String(fields["更新来源"]);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "完成": remote.done, "更新来源": remote.source } } } });
    if (url === "https://api.openai.com/v1/responses") {
      modelCalls += 1;
      modelEntered();
      return new Promise((resolve) => { releaseModel = () => resolve(Response.json({ id: "resp-concurrent", output_text: JSON.stringify({ intent: "task_state_update", entity: "task-1", target_state: "done", confidence: 0.99, reason: "matched" }) })); });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?concurrent-message=${Date.now()}`, import.meta.url).href);
    const body = JSON.stringify(feishuMessage("msg-concurrent", openId, "完成并发真任务"));
    let firstWork;
    await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body }), env, { waitUntil(promise) { firstWork = promise; } });
    await entered;
    let duplicateWork;
    const duplicate = await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body }), env, { waitUntil(promise) { duplicateWork = promise; } });
    assert.equal((await duplicate.json()).requeued, true);
    releaseModel();
    await Promise.all([firstWork, duplicateWork]);
    assert.equal(modelCalls, 1);
    assert.equal(botMessages.filter((message) => message.includes("已收到，正在用 AI")).length, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM commands").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM gates").get().count, 1);

    const commandId = database.prepare("SELECT command_id FROM commands").get().command_id;
    let gateWork;
    await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body: JSON.stringify(feishuMessage("msg-concurrent-gate", openId, `确认 ${commandId}`)) }), env, { waitUntil(promise) { gateWork = promise; } });
    await gateWork;
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "succeeded");
    assert.equal(database.prepare("SELECT count(*) AS count FROM receipts").get().count, 1);
    assert.equal(botMessages.filter((message) => message.includes("OPS 已写回")).length, 1);
  } finally {
    releaseModel?.();
    globalThis.fetch = original;
    database.close();
  }
});

test("the durable scanner fences a model call crossing the default lease without a duplicate delivery", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  const openId = "ou-long-model";
  const env = webhookEnv(d1, await openIdHash(openId));
  delete env.COMMAND_PROCESSING_LEASE_MS;
  const original = globalThis.fetch;
  const delivered = [];
  let modelCalls = 0;
  let releaseModel;
  let modelEntered;
  const entered = new Promise((resolve) => { modelEntered = resolve; });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      delivered.push(JSON.parse(JSON.parse(String(init.body)).content).text);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records?page_size=200")) return Response.json({ code: 0, data: { items: [{ record_id: "record-1", fields: { task_id: "task-1", "任务": "慢模型任务", "项目": "项目", "完成": false } }] } });
    if (url === "https://api.openai.com/v1/responses") {
      modelCalls += 1;
      modelEntered();
      return new Promise((resolve) => { releaseModel = () => resolve(Response.json({ id: "resp-too-late", output_text: JSON.stringify({ intent: "task_state_update", entity: "task-1", target_state: "done", confidence: 0.99, reason: "late" }) })); });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?long-model=${Date.now()}`, import.meta.url).href);
    const body = JSON.stringify(feishuMessage("msg-long-model", openId, "完成慢模型任务"));
    const startedAt = Date.now();
    let firstWork;
    await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body }), env, { waitUntil(promise) { firstWork = promise; } });
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    let recoveryWork;
    await worker.scheduled({}, env, { waitUntil(promise) { recoveryWork = promise; } });
    await recoveryWork;
    releaseModel();
    await firstWork;

    assert.equal(modelCalls, 1);
    assert.equal(delivered.filter((message) => message.includes("已收到，正在用 AI")).length, 1);
    assert.equal(delivered.filter((message) => message.includes("AI 调用结果无法确认")).length, 1);
    assert.equal(delivered.filter((message) => message.includes("请确认写回")).length, 0);
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "needs_input");
    assert.equal(database.prepare("SELECT count(*) AS count FROM gates").get().count, 0);
    assert.ok(Date.now() - startedAt < 10_000, "default takeover must finish well inside the 30-second waitUntil budget");
  } finally {
    releaseModel?.();
    globalThis.fetch = original;
    database.close();
  }
});

test("a failed Gate notification is retried from the durable outbox without rerunning the model", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.failModelResolvedEvents = 1;
  const openId = "ou-gate-outbox";
  const env = webhookEnv(d1, await openIdHash(openId));
  const original = globalThis.fetch;
  let modelCalls = 0;
  let gateAttempts = 0;
  const delivered = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      const text = JSON.parse(JSON.parse(String(init.body)).content).text;
      if (text.includes("请确认写回")) {
        gateAttempts += 1;
        if (gateAttempts === 1) return new Response("unavailable", { status: 503 });
      }
      delivered.push(text);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records?page_size=200")) return Response.json({ code: 0, data: { items: [{ record_id: "record-1", fields: { task_id: "task-1", "任务": "通知恢复任务", "项目": "项目", "完成": false } }] } });
    if (url === "https://api.openai.com/v1/responses") {
      modelCalls += 1;
      return Response.json({ id: "resp-gate-outbox", output_text: JSON.stringify({ intent: "task_state_update", entity: "task-1", target_state: "done", confidence: 0.99, reason: "matched" }) });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?gate-outbox=${Date.now()}`, import.meta.url).href);
    const body = JSON.stringify(feishuMessage("msg-gate-outbox", openId, "完成通知恢复任务"));
    let firstWork;
    await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body }), env, { waitUntil(promise) { firstWork = promise; } });
    await firstWork;
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "needs_confirmation");
    assert.equal(database.prepare("SELECT status FROM notification_outbox WHERE kind = 'gate_request'").get().status, "failed");

    let recoveryWork;
    await worker.scheduled({}, env, { waitUntil(promise) { recoveryWork = promise; } });
    await recoveryWork;
    assert.equal(modelCalls, 1);
    assert.equal(gateAttempts, 2);
    assert.equal(delivered.filter((message) => message.includes("请确认写回")).length, 1);
    assert.equal(database.prepare("SELECT status FROM notification_outbox WHERE kind = 'gate_request'").get().status, "sent");
    assert.equal(database.prepare("SELECT count(*) AS count FROM gates").get().count, 1);
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("Gate approval batch failure rolls back and the same reply reaches one terminal receipt", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.failGateApprovalBatches = 1;
  const openId = "ou-atomic-gate";
  const actor = await openIdHash(openId);
  const env = webhookEnv(d1, actor);
  seedCommand(database, { commandId: "cmd_cafebabe", runId: "run-atomic-gate", targetState: "done", expectedVersion: 0 });
  database.prepare("UPDATE commands SET status = 'needs_confirmation', actor_hash = ? WHERE command_id = 'cmd_cafebabe'").run(actor);
  database.prepare("UPDATE runs SET status = 'needs_confirmation' WHERE run_id = 'run-atomic-gate'").run();
  database.prepare("INSERT INTO gates (gate_id, command_id, status, before_json, after_json, requested_at) VALUES ('gate-atomic', 'cmd_cafebabe', 'pending', '{}', '{}', 1)").run();
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  const original = globalThis.fetch;
  const remote = { done: false, source: "manual" };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) return Response.json({ code: 0, data: {} });
    if (url.includes("/records/record-1") && init.method === "PUT") {
      const fields = JSON.parse(String(init.body)).fields;
      remote.done = Boolean(fields["完成"]);
      remote.source = String(fields["更新来源"]);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "完成": remote.done, "更新来源": remote.source } } } });
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?atomic-gate=${Date.now()}`, import.meta.url).href);
    const body = JSON.stringify(feishuMessage("msg-atomic-gate", openId, "确认 cmd_cafebabe"));
    let firstWork;
    const first = await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body }), env, { waitUntil(promise) { firstWork = promise; } });
    assert.equal(first.status, 502);
    assert.equal(firstWork, undefined);
    assert.deepEqual({ ...database.prepare("SELECT status FROM commands").get() }, { status: "needs_confirmation" });
    assert.deepEqual({ ...database.prepare("SELECT status FROM runs").get() }, { status: "needs_confirmation" });
    assert.deepEqual({ ...database.prepare("SELECT status FROM gates").get() }, { status: "pending" });
    assert.equal(database.prepare("SELECT count(*) AS count FROM receipts").get().count, 0);

    let replayWork;
    const replay = await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body }), env, { waitUntil(promise) { replayWork = promise; } });
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).durable, true);
    await replayWork;
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "succeeded");
    assert.equal(database.prepare("SELECT status FROM runs").get().status, "succeeded");
    assert.equal(database.prepare("SELECT status FROM gates").get().status, "approved");
    assert.equal(database.prepare("SELECT count(*) AS count FROM receipts").get().count, 1);
    assert.equal(remote.done, true);
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("Gate cancellation withholds ACK after a post-commit crash and the retry gets one durable receipt", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.crashAfterGateCancelCommits = 1;
  const openId = "ou-cancel-outbox";
  const actor = await openIdHash(openId);
  const env = webhookEnv(d1, actor);
  seedCommand(database, { commandId: "cmd_deadbeef", runId: "run-cancel-outbox", targetState: "done", expectedVersion: 0 });
  database.prepare("UPDATE commands SET status = 'needs_confirmation', actor_hash = ? WHERE command_id = 'cmd_deadbeef'").run(actor);
  database.prepare("UPDATE runs SET status = 'needs_confirmation' WHERE run_id = 'run-cancel-outbox'").run();
  database.prepare("INSERT INTO gates (gate_id, command_id, status, before_json, after_json, requested_at) VALUES ('gate-cancel-outbox', 'cmd_deadbeef', 'pending', '{}', '{}', 1)").run();
  const original = globalThis.fetch;
  const delivered = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      delivered.push({ ...JSON.parse(String(init.body)), text: JSON.parse(JSON.parse(String(init.body)).content).text });
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?cancel-outbox=${Date.now()}`, import.meta.url).href);
    let firstWork;
    const first = await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body: JSON.stringify(feishuMessage("msg-cancel-outbox", openId, "取消 cmd_deadbeef")) }), env, { waitUntil(promise) { firstWork = promise; } });
    assert.equal(first.status, 502);
    assert.equal(firstWork, undefined);
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "cancelled");
    assert.equal(database.prepare("SELECT status FROM runs").get().status, "cancelled");
    assert.equal(database.prepare("SELECT status FROM gates").get().status, "cancelled");
    const pending = database.prepare("SELECT notification_id, status FROM notification_outbox WHERE kind = 'gate_cancelled'").get();
    assert.equal(pending.status, "pending");
    assert.equal(delivered.length, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM feishu_event_receipts").get().count, 0);

    let retryWork;
    const retry = await worker.fetch(new Request("http://localhost/api/feishu/events", { method: "POST", body: JSON.stringify(feishuMessage("msg-cancel-outbox", openId, "取消 cmd_deadbeef")) }), env, { waitUntil(promise) { retryWork = promise; } });
    assert.equal(retry.status, 202);
    assert.equal((await retry.json()).durable, true);
    await retryWork;
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /已取消，没有写回/);
    assert.equal(delivered[0].uuid, pending.notification_id);
    assert.equal(database.prepare("SELECT status FROM notification_outbox WHERE kind = 'gate_cancelled'").get().status, "sent");
    assert.equal(database.prepare("SELECT count(*) AS count FROM feishu_event_receipts").get().count, 1);
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("H5 command, run, approved Gate, and recovery recipient commit atomically", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  d1.failApprovedGateInserts = 1;
  const openId = "ou-h5-atomic";
  const env = webhookEnv(d1, await openIdHash(openId));
  const original = globalThis.fetch;
  const remote = { done: false, source: "manual" };
  let puts = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) return Response.json({ code: 0, data: {} });
    if (url.includes("/records/record-1") && init.method === "PUT") {
      puts += 1;
      const fields = JSON.parse(String(init.body)).fields;
      remote.done = Boolean(fields["完成"]);
      remote.source = String(fields["更新来源"]);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "任务": "H5 原子任务", "完成": remote.done, "更新来源": remote.source } } } });
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?h5-atomic=${Date.now()}`, import.meta.url).href);
    const body = JSON.stringify({ taskId: "task-1", recordId: "record-1", targetState: "done", expectedVersion: 0, idempotencyKey: "h5:atomic-command-0001", label: "完成 H5 原子任务" });
    const headers = { "content-type": "application/json", cookie: await sessionCookie(openId) };
    const first = await worker.fetch(new Request("http://localhost/api/commands", { method: "POST", headers, body }), env, { waitUntil() {} });
    assert.equal(first.status, 502);
    assert.equal(database.prepare("SELECT count(*) AS count FROM commands").get().count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM runs").get().count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM gates").get().count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM notification_outbox").get().count, 0);
    assert.equal(puts, 0);

    const background = [];
    const replay = await worker.fetch(new Request("http://localhost/api/commands", { method: "POST", headers, body }), env, { waitUntil(promise) { background.push(promise); } });
    assert.equal(replay.status, 200);
    await Promise.all(background);
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "succeeded");
    assert.equal(database.prepare("SELECT status FROM gates").get().status, "approved");
    assert.equal(database.prepare("SELECT count(*) AS count FROM receipts").get().count, 1);
    assert.ok(database.prepare("SELECT count(*) AS count FROM notification_outbox").get().count >= 2);
    assert.equal(puts, 1);
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});

test("a hanging start notification cannot block execution and is recovered by the durable scanner", async () => {
  const database = await migratedDatabase();
  const d1 = new D1Harness(database);
  const openId = "ou-start-outbox";
  const actor = await openIdHash(openId);
  const env = webhookEnv(d1, actor);
  seedCommand(database, { commandId: "cmd_57a47baa", runId: "run-startbox", targetState: "done", expectedVersion: 0 });
  database.prepare("UPDATE commands SET actor_hash = ? WHERE command_id = 'cmd_57a47baa'").run(actor);
  database.prepare("INSERT INTO gates (gate_id, command_id, status, before_json, after_json, requested_at, decided_at, decided_by_hash) VALUES ('gate-startbox', 'cmd_57a47baa', 'approved', '{}', '{}', 1, 1, ?)").run(actor);
  database.prepare(`INSERT INTO notification_outbox
    (notification_id, command_id, run_id, kind, recipient_ciphertext, body_text, status, attempts, lease_until, created_at, updated_at)
    VALUES (?, 'cmd_57a47baa', 'run-startbox', 'projection_start', ?, '确认收到，正在写回。\nrun: run-startbox', 'pending', 0, NULL, 1, 1)`)
    .run(await durableNotificationId("cmd_57a47baa", "projection_start"), await encryptedRecipient(openId));
  database.prepare("INSERT INTO task_entities (task_id, record_id, state, version, updated_at) VALUES ('task-1', 'record-1', 0, 0, 1)").run();
  const original = globalThis.fetch;
  const remote = { done: false, source: "manual" };
  const delivered = [];
  let startAttempts = 0;
  let puts = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "dummy-token" });
    if (url.includes("/im/v1/messages")) {
      const text = JSON.parse(JSON.parse(String(init.body)).content).text;
      if (text.includes("确认收到，正在写回")) {
        startAttempts += 1;
        return new Promise(() => {});
      }
      delivered.push(text);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1") && init.method === "PUT") {
      puts += 1;
      const fields = JSON.parse(String(init.body)).fields;
      remote.done = Boolean(fields["完成"]);
      remote.source = String(fields["更新来源"]);
      return Response.json({ code: 0, data: {} });
    }
    if (url.includes("/records/record-1")) return Response.json({ code: 0, data: { record: { record_id: "record-1", fields: { task_id: "task-1", "完成": remote.done, "更新来源": remote.source } } } });
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?start-outbox=${Date.now()}`, import.meta.url).href);
    let recoveryWork;
    const startedAt = Date.now();
    await worker.scheduled({}, env, { waitUntil(promise) { recoveryWork = promise; } });
    await recoveryWork;
    assert.ok(Date.now() - startedAt < 1_000);
    assert.ok(startAttempts >= 1);
    assert.equal(puts, 1);
    assert.equal(delivered.filter((message) => message.includes("OPS 已写回")).length, 1);
    assert.equal(database.prepare("SELECT status FROM commands").get().status, "succeeded");
    assert.equal(database.prepare("SELECT count(*) AS count FROM receipts").get().count, 1);
    assert.equal(database.prepare("SELECT status FROM notification_outbox WHERE kind = 'projection_start'").get().status, "failed");
  } finally {
    globalThis.fetch = original;
    database.close();
  }
});
