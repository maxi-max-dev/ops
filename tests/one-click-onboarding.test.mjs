import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  MAXOPS_PORTABLE_TEMPLATE,
  assertPortableTemplateSafe,
  buildPortableTableCreatePayload,
  materializePortableRecords,
  portableCanaryMatrix,
  validatePortableDiscovery,
} from "../worker/onboarding-contract.mjs";

class OnboardingStatement {
  constructor(owner, sql, bindings = []) { this.owner = owner; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new OnboardingStatement(this.owner, this.sql, bindings); }
  async run() {
    const result = this.owner.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async first() { return this.owner.database.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.owner.database.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
}

class OnboardingD1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new OnboardingStatement(this, sql); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function cookieValue(response, name) {
  const value = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${name}=([^;,]+)`).exec(value);
  return match ? `${name}=${match[1]}` : "";
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function semanticDigest(event) {
  const semantic = { ...event };
  delete semantic.event_id;
  delete semantic.occurred_at;
  return createHash("sha256").update(stableStringify(semantic)).digest("hex");
}

test("portable template contains exactly the five Connector business tables", () => {
  assert.deepEqual(MAXOPS_PORTABLE_TEMPLATE.tables.map((table) => table.name), [
    "项目", "任务", "Agent 事件", "问题／反馈", "产物／回执",
  ]);
  assertPortableTemplateSafe(MAXOPS_PORTABLE_TEMPLATE);
  const viewNames = MAXOPS_PORTABLE_TEMPLATE.tables.flatMap((table) => [table.defaultView, ...table.views.map((view) => view.name)]);
  for (const name of ["今天", "项目", "动态", "项目详情"]) assert.ok(viewNames.includes(name));
});

test("provisioner payloads preserve primary human fields and stable Connector fields", () => {
  const payloads = MAXOPS_PORTABLE_TEMPLATE.tables.map(buildPortableTableCreatePayload);
  assert.equal(payloads.length, 5);
  assert.deepEqual(payloads.map((payload) => payload.table.fields[0].field_name), ["项目名", "任务名", "事件摘要", "标题", "产物名"]);
  const eventFields = payloads[2].table.fields.map((field) => field.field_name);
  for (const name of ["instance_id", "task_id", "event_id", "idempotency_key", "payload_digest", "agent_id", "run_id"]) assert.ok(eventFields.includes(name));
});

test("sanitized runtime records create one real connection-test assignment", () => {
  const records = materializePortableRecords({
    instanceId: "instance_0000000000000000",
    projectId: "project_00000000000000000",
    taskId: "task_000000000000000000000",
    now: 1_800_000_000_000,
  });
  assert.equal(records.projects.length, 1);
  assert.equal(records.tasks.length, 1);
  assert.equal(records.tasks[0]["任务名"], "连接测试");
  assert.equal(records.events.length + records.feedback.length + records.receipts.length, 0);
  assertPortableTemplateSafe(records, ["Private Person", "/Users/private-user"]);
});

test("local fidelity verifier fails when a discovered field is missing", () => {
  const discovered = Object.fromEntries(MAXOPS_PORTABLE_TEMPLATE.tables.map((table) => [table.name, table.fields.map((field) => field.name)]));
  assert.equal(validatePortableDiscovery(discovered), true);
  discovered["任务"] = discovered["任务"].filter((name) => name !== "task_id");
  assert.throws(() => validatePortableDiscovery(discovered), /任务\.task_id/);
});

test("unverified native surfaces remain explicit canary gates", () => {
  const matrix = portableCanaryMatrix();
  for (const surface of ["应用模式", "飞书 AI Agent", "自动化", "跨租户权限"]) {
    assert.equal(matrix.find((item) => item.surface === surface)?.status, "UNAVAILABLE_SECOND_TENANT");
  }
});

test("public Worker configuration contains no Store App or onboarding secret", async () => {
  const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /MAXOPS_STORE_APP_SECRET|MAXOPS_ONBOARDING_KEY/);
  const onboardingWrangler = await readFile(new URL("../wrangler.onboarding.jsonc", import.meta.url), "utf8");
  assert.match(onboardingWrangler, /"MAXOPS_ONBOARDING_ONLY": "true"/);
  assert.match(onboardingWrangler, /"MAXOPS_OAUTH_SCOPES": "bitable:app offline_access"/);
  assert.doesNotMatch(onboardingWrangler, /MAXOPS_STORE_APP_ID|MAXOPS_STORE_APP_SECRET|MAXOPS_ONBOARDING_KEY/);
  const onboardingMigration = await readFile(new URL("../drizzle-onboarding/0001_onboarding.sql", import.meta.url), "utf8");
  assert.doesNotMatch(onboardingMigration, /CREATE TABLE `(?:commands|runs|entities|projects|tasks)`/);
  const source = await readFile(new URL("../worker/onboarding.ts", import.meta.url), "utf8");
  assert.match(source, /permission_gate/);
  assert.match(source, /basePreserved: true/);
});

test("built public installer fails closed, while configured local canary redirects only to Feishu", async () => {
  const { default: worker } = await import(new URL(`../dist/server/index.js?onboarding-status=${Date.now()}`, import.meta.url).href);
  const ctx = { waitUntil() {} };
  const closed = await worker.fetch(new Request("https://public.example/api/install/status"), { DB: {} }, ctx);
  assert.equal(closed.status, 200);
  const closedStatus = await closed.json();
  assert.equal(closedStatus.state, "permission_gate");
  assert.doesNotMatch(closedStatus.reason, /域名尚未发布/);
  const blocked = await worker.fetch(new Request("https://public.example/api/install/start"), { DB: {} }, ctx);
  assert.equal(blocked.status, 503);
  const privateApi = await worker.fetch(new Request("https://public.example/api/agent/v1/health"), { DB: {}, MAXOPS_ONBOARDING_ONLY: "true" }, ctx);
  assert.equal(privateApi.status, 404);

  const local = await worker.fetch(new Request("http://localhost:8787/api/install/start"), {
    DB: {},
    MAXOPS_STORE_APP_ID: "local-app-id",
    MAXOPS_STORE_APP_SECRET: "local-app-secret",
    MAXOPS_ONBOARDING_KEY: "local-onboarding-key-with-at-least-32-bytes",
    MAXOPS_INSTALL_PUBLIC_ORIGIN: "http://localhost:8787",
    MAXOPS_OAUTH_SCOPES: "bitable:app offline_access",
  }, ctx);
  assert.equal(local.status, 302);
  const target = new URL(local.headers.get("location"));
  assert.equal(target.origin, "https://accounts.feishu.cn");
  assert.equal(target.searchParams.get("client_id"), "local-app-id");
  assert.equal(target.searchParams.get("app_id"), null);
  assert.equal(target.searchParams.get("scope"), "bitable:app offline_access");
  assert.doesNotMatch(target.href, /local-app-secret|local-onboarding-key/);
  assert.match(local.headers.get("set-cookie") ?? "", /HttpOnly; Secure; SameSite=Lax/);
});

test("local canary installs, pairs once, writes a Base progress receipt, and revokes immediately", async () => {
  const database = new DatabaseSync(":memory:");
  const migration = await readFile(new URL("../drizzle-onboarding/0001_onboarding.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) database.exec(statement);
  const d1 = new OnboardingD1(database);
  const tables = new Map();
  const records = new Map();
  const fieldLists = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.origin === "https://accounts.feishu.cn" && url.pathname === "/oauth/v3/token") {
      return Response.json({ access_token: "u-local-token", refresh_token: "r-local-token", expires_in: 7200, refresh_token_expires_in: 2_592_000 });
    }
    if (url.pathname === "/open-apis/authen/v1/user_info") return Response.json({ code: 0, data: { open_id: "ou_local_canary", tenant_key: "tenant_local_canary", name: "Canary" } });
    if (url.pathname === "/open-apis/bitable/v1/apps" && init.method === "POST") return Response.json({ code: 0, data: { app: { app_token: "base_local_canary", url: "https://example.feishu.cn/base/BASE_TOKEN", default_table_id: "tbl_default" } } });
    if (/\/tables$/.test(url.pathname) && init.method === "POST") {
      const tableId = `tbl_${tables.size + 1}`;
      tables.set(body.table.name, tableId);
      records.set(tableId, []);
      fieldLists.set(tableId, body.table.fields.map((field, index) => ({ field_id: `fld_${tableId}_${index}`, field_name: field.field_name })));
      return Response.json({ code: 0, data: { table_id: tableId } });
    }
    if (/\/records\/batch_create$/.test(url.pathname) && init.method === "POST") {
      const tableId = url.pathname.split("/").at(-3);
      const bucket = records.get(tableId);
      for (const row of body.records) bucket.push({ record_id: `rec_${tableId}_${bucket.length + 1}`, fields: row.fields });
      return Response.json({ code: 0, data: { records: bucket } });
    }
    if (/\/views$/.test(url.pathname) && init.method === "POST") return Response.json({ code: 0, data: { view: { view_id: "view_local" } } });
    if (/\/tables\/batch_delete$/.test(url.pathname)) return Response.json({ code: 0, data: {} });
    if (/\/tables$/.test(url.pathname) && init.method !== "POST") return Response.json({ code: 0, data: { items: [...tables.entries()].map(([name, table_id]) => ({ name, table_id })) } });
    if (/\/fields$/.test(url.pathname)) {
      const tableId = url.pathname.split("/").at(-2);
      return Response.json({ code: 0, data: { items: fieldLists.get(tableId) } });
    }
    if (/\/records\/search$/.test(url.pathname) && init.method === "POST") {
      const tableId = url.pathname.split("/").at(-3);
      const conditions = body.filter?.conditions ?? [];
      const items = (records.get(tableId) ?? []).filter((row) => conditions.every((condition) => String(row.fields[condition.field_name] ?? "") === String(condition.value[0])));
      return Response.json({ code: 0, data: { items, has_more: false } });
    }
    if (/\/records$/.test(url.pathname) && init.method === "POST") {
      const tableId = url.pathname.split("/").at(-2);
      const bucket = records.get(tableId);
      const row = { record_id: `rec_${tableId}_${bucket.length + 1}`, fields: body.fields };
      bucket.push(row);
      return Response.json({ code: 0, data: { record: row } });
    }
    throw new Error(`Unexpected Feishu canary request: ${init.method ?? "GET"} ${url}`);
  };

  try {
    const { default: worker } = await import(new URL(`../dist/server/index.js?onboarding-e2e=${Date.now()}`, import.meta.url).href);
    const env = {
      DB: d1,
      MAXOPS_STORE_APP_ID: "local-app-id",
      MAXOPS_STORE_APP_SECRET: "local-app-secret",
      MAXOPS_ONBOARDING_KEY: "local-onboarding-key-with-at-least-32-bytes",
      MAXOPS_INSTALL_PUBLIC_ORIGIN: "https://install.example",
      MAXOPS_OAUTH_SCOPES: "bitable:app offline_access",
    };
    const ctx = { waitUntil() {} };
    const start = await worker.fetch(new Request("https://upstream.example/api/install/start"), env, ctx);
    const authorize = new URL(start.headers.get("location"));
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://install.example/api/install/callback");
    const state = authorize.searchParams.get("state");
    const callback = await worker.fetch(new Request(`https://upstream.example/api/install/callback?code=local-code&state=${encodeURIComponent(state)}`, { headers: { cookie: cookieValue(start, "maxops_install_state") } }), env, ctx);
    assert.equal(callback.status, 302);
    const sessionCookie = cookieValue(callback, "maxops_install_session");
    assert.ok(sessionCookie);

    const workspace = await worker.fetch(new Request("https://upstream.example/api/install/workspace", { headers: { cookie: sessionCookie } }), env, ctx);
    const workspaceBody = await workspace.json();
    assert.equal(workspaceBody.installed, true);
    assert.equal(workspaceBody.links.feishu, "/api/install/open/feishu");
    assert.doesNotMatch(JSON.stringify(workspaceBody), /base_local_canary|tbl_|instance_|task_|local-token|local-secret/);

    const pair = await worker.fetch(new Request("https://upstream.example/api/install/pair", { method: "POST", headers: { cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify({ agentName: "Canary Agent" }) }), env, ctx);
    const pairBody = await pair.json();
    assert.match(pairBody.instruction, /^请接入我的 OPS 并完成连接自检：https:\/\/install\.example\/pair\//);
    const pairUrl = new URL(pairBody.pairingUrl);
    const manifest = await worker.fetch(new Request(pairUrl, { headers: { accept: "application/json" } }), env, ctx);
    const manifestBody = await manifest.json();
    assert.equal(manifestBody.one_time, true);
    assert.match(manifestBody.exchange_url, /^https:\/\/install\.example\/pair\//);
    assert.doesNotMatch(JSON.stringify(manifestBody), /upstream\.example|workers\.dev/);

    const exchangeUrl = `${pairUrl}/exchange`;
    const exchange = await worker.fetch(new Request(exchangeUrl, { method: "POST" }), env, ctx);
    assert.equal(exchange.status, 201);
    const exchangeBody = await exchange.json();
    const agentToken = exchangeBody.credential.token;
    assert.equal(exchangeBody.connector.environment.MAXOPS_INSTANCE_ID.startsWith("instance_"), true);
    assert.equal(exchangeBody.connector.environment.MAXOPS_TASK_ID.startsWith("task_"), true);
    assert.doesNotMatch(JSON.stringify(exchangeBody), /local-app-secret|base_local_canary|tbl_/);
    const replayExchange = await worker.fetch(new Request(exchangeUrl, { method: "POST" }), env, ctx);
    assert.equal(replayExchange.status, 410);

    const bootstrap = await worker.fetch(new Request(exchangeBody.bootstrap_url, { headers: { authorization: `Bearer ${agentToken}` } }), env, ctx);
    const bootstrapBody = await bootstrap.json();
    assert.equal(bootstrapBody.assignment.title, "连接测试");
    const event = {
      schema_version: "maxops-agent-event/1",
      instance_id: bootstrapBody.assignment.instance_id,
      event_id: "evt_local_canary",
      task_id: bootstrapBody.assignment.task_id,
      agent_id: bootstrapBody.agent.id,
      agent_name: bootstrapBody.agent.name,
      run_id: "run_local_canary",
      kind: "progress",
      state: "running",
      title: "连接自检通过",
      detail: "已读取连接测试任务，并把真实 progress 写回用户 Base。",
      occurred_at: "2026-09-01T12:00:00+08:00",
    };
    const idempotencyKey = "local-canary-progress-0001";
    const envelope = { schema_version: "maxops-webhook-write/1", instance_id: event.instance_id, idempotency_key: idempotencyKey, payload_digest: semanticDigest(event), event };
    const eventRequest = () => new Request(exchangeBody.connector.environment.MAXOPS_WEBHOOK_URL, { method: "POST", headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(envelope) });
    const written = await worker.fetch(eventRequest(), env, ctx);
    const writtenBody = await written.json();
    assert.equal(written.status, 201);
    assert.equal(writtenBody.receipt_id, "event:evt_local_canary");
    const duplicate = await worker.fetch(eventRequest(), env, ctx);
    assert.equal((await duplicate.json()).duplicate, true);

    const agentId = exchangeBody.connector.environment.MAXOPS_AGENT_ID;
    const revoked = await worker.fetch(new Request(`https://upstream.example/api/install/agents/${agentId}/revoke`, { method: "POST", headers: { cookie: sessionCookie } }), env, ctx);
    assert.equal((await revoked.json()).revoked, true);
    const denied = await worker.fetch(new Request(exchangeBody.bootstrap_url, { headers: { authorization: `Bearer ${agentToken}` } }), env, ctx);
    assert.equal(denied.status, 401);
    const revokedWorkspace = await worker.fetch(new Request("https://upstream.example/api/install/revoke", { method: "POST", headers: { cookie: sessionCookie } }), env, ctx);
    assert.deepEqual(await revokedWorkspace.json(), { ok: true, basePreserved: true });
    assert.equal((records.get(tables.get("Agent 事件")) ?? []).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
