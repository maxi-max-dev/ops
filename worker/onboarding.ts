import {
  MAXOPS_PORTABLE_TEMPLATE,
  buildPortableTableCreatePayload,
  materializePortableRecords,
  normalizePortableAgentName,
  portableCanaryMatrix,
} from "./onboarding-contract.mjs";
import { projectFreshBase } from "./fresh-base.mjs";

export interface OnboardingEnv {
  DB: D1Database;
  MAXOPS_STORE_APP_ID?: string;
  MAXOPS_STORE_APP_SECRET?: string;
  MAXOPS_ONBOARDING_KEY?: string;
  MAXOPS_INSTALL_PUBLIC_ORIGIN?: string;
  MAXOPS_OAUTH_SCOPES?: string;
}

type ExecutionContextLike = { waitUntil(promise: Promise<unknown>): void };
type SecretPayload = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  ownerOpenId: string;
  tenantKey: string;
  appToken: string;
  baseUrl: string;
  tables: Record<string, string>;
  fields: Record<string, Record<string, string>>;
  testTask: { instanceId: string; projectId: string; taskId: string; recordId: string };
};
type WorkspaceRow = {
  workspace_id: string;
  owner_hash: string;
  tenant_hash: string;
  display_name: string;
  secret_ciphertext: string;
  token_expires_at: number;
  refresh_expires_at: number;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
};
type PairRow = {
  code_hash: string;
  workspace_id: string;
  agent_name: string;
  task_id: string;
  expires_at: number;
  used_at: number | null;
};
type AgentRow = {
  credential_hash: string;
  workspace_id: string;
  agent_id: string;
  agent_name: string;
  task_id: string;
  revoked_at: number | null;
  last_seen_at: number | null;
  first_receipt_id: string | null;
  created_at: number;
};

const INSTALL_SESSION_COOKIE = "maxops_install_session";
const INSTALL_STATE_COOKIE = "maxops_install_state";
const PAIR_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const FEISHU_API = "https://open.feishu.cn";
const FEISHU_ACCOUNTS = "https://accounts.feishu.cn";
const CONNECTOR_KINDS: Record<string, string> = {
  run_started: "running",
  progress: "running",
  blocked: "blocked",
  question: "blocked",
  artifact: "done",
  run_finished: "done",
};

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

function boundedString(value: unknown, max = 200) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function randomToken(bytes = 24) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey(secret: string, usages: KeyUsage[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`maxops-onboarding-v1:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, usages);
}

async function seal(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(secret, ["encrypt"]), new TextEncoder().encode(value));
  const bytes = new Uint8Array(iv.length + encrypted.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(encrypted), iv.length);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function open(value: string, secret: string) {
  const bytes = decodeBase64Url(value);
  if (bytes.length < 29) throw new Error("Invalid encrypted value");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await encryptionKey(secret, ["decrypt"]), bytes.slice(12));
  return new TextDecoder().decode(plain);
}

function parseCookies(request: Request) {
  return Object.fromEntries((request.headers.get("cookie") ?? "").split(";").map((item) => {
    const [name, ...parts] = item.trim().split("=");
    return [name, decodeURIComponent(parts.join("="))];
  }).filter(([name]) => name));
}

function cookie(name: string, value: string, maxAgeSeconds: number) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function configuredOrigin(env: OnboardingEnv, request: Request) {
  const raw = env.MAXOPS_INSTALL_PUBLIC_ORIGIN || new URL(request.url).origin;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const local = new Set(["localhost", "127.0.0.1"]).has(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  if (!local && (url.hostname.endsWith(".workers.dev") || url.hostname.endsWith(".github.io"))) return null;
  return url.origin;
}

export function onboardingAvailability(env: OnboardingEnv, request: Request) {
  const origin = configuredOrigin(env, request);
  const oauthScopes = new Set((env.MAXOPS_OAUTH_SCOPES || "").split(/\s+/).filter(Boolean));
  const configured = Boolean(
    env.MAXOPS_STORE_APP_ID
    && env.MAXOPS_STORE_APP_SECRET
    && env.MAXOPS_ONBOARDING_KEY
    && env.MAXOPS_ONBOARDING_KEY.length >= 32
    && oauthScopes.has("offline_access")
    && origin,
  );
  return {
    state: configured ? "ready" : "permission_gate",
    installUrl: configured ? "/api/install/start" : null,
    label: configured ? "可安装" : "对外安装链接待发布",
    reason: configured ? null : "飞书非公开商店应用尚未创建或配置，离线授权与 OAuth 回调还未完成实机验证",
    origin,
  } as const;
}

async function feishuJson<T>(path: string, init: RequestInit, accessToken?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${FEISHU_API}${path}`, { ...init, headers });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* handled below */ }
  if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
    const code = typeof payload.code === "number" ? ` (${payload.code})` : "";
    throw new Error(`Feishu request rejected${code}`);
  }
  return payload as T;
}

async function exchangeCode(env: OnboardingEnv, code: string, redirectUri: string) {
  const response = await fetch(`${FEISHU_ACCOUNTS}/oauth/v3/token`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: env.MAXOPS_STORE_APP_ID,
      client_secret: env.MAXOPS_STORE_APP_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") throw new Error("Feishu OAuth exchange failed");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: Number(body.expires_in) || 7_200,
    refreshExpiresIn: Number(body.refresh_token_expires_in) || 30 * 24 * 60 * 60,
  };
}

async function refreshAccess(env: OnboardingEnv, refreshToken: string) {
  const response = await fetch(`${FEISHU_ACCOUNTS}/oauth/v3/token`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: env.MAXOPS_STORE_APP_ID,
      client_secret: env.MAXOPS_STORE_APP_SECRET,
      refresh_token: refreshToken,
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") throw new Error("Feishu token refresh failed");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: Number(body.expires_in) || 7_200,
    refreshExpiresIn: Number(body.refresh_token_expires_in) || 30 * 24 * 60 * 60,
  };
}

type ProvisionedBase = Pick<SecretPayload, "appToken" | "baseUrl" | "tables" | "fields" | "testTask">;

export async function provisionPortableBase(accessToken: string): Promise<ProvisionedBase> {
  const created = await feishuJson<{ data?: { app?: { app_token?: string; url?: string; default_table_id?: string } } }>("/open-apis/bitable/v1/apps", {
    method: "POST",
    body: JSON.stringify({ name: MAXOPS_PORTABLE_TEMPLATE.name, time_zone: MAXOPS_PORTABLE_TEMPLATE.timeZone }),
  }, accessToken);
  const appToken = created.data?.app?.app_token;
  const defaultTableId = created.data?.app?.default_table_id;
  const baseUrl = created.data?.app?.url;
  if (!appToken || !defaultTableId || !baseUrl) throw new Error("Feishu did not return a complete Base locator");

  const instanceId = `instance_${crypto.randomUUID()}`;
  const projectId = `project_${crypto.randomUUID()}`;
  const taskId = `task_${crypto.randomUUID()}`;
  const records = materializePortableRecords({ instanceId, projectId, taskId });
  const tables: Record<string, string> = {};

  for (const table of MAXOPS_PORTABLE_TEMPLATE.tables) {
    const result = await feishuJson<{ data?: { table_id?: string } }>(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, {
      method: "POST",
      body: JSON.stringify(buildPortableTableCreatePayload(table)),
    }, accessToken);
    const tableId = result.data?.table_id;
    if (!tableId) throw new Error(`Feishu did not create table ${table.key}`);
    tables[table.key] = tableId;
    const rows = records[table.key as keyof typeof records];
    if (rows.length) {
      await feishuJson(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_create`, {
        method: "POST",
        body: JSON.stringify({ records: rows.map((fields) => ({ fields })) }),
      }, accessToken);
    }
    for (const view of table.views) {
      await feishuJson(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/views`, {
        method: "POST",
        body: JSON.stringify({ view_name: view.name, view_type: view.type }),
      }, accessToken);
    }
  }

  await feishuJson(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/batch_delete`, {
    method: "POST",
    body: JSON.stringify({ table_ids: [defaultTableId] }),
  }, accessToken);

  const discoveredTables = await feishuJson<{ data?: { items?: Array<{ table_id?: string; name?: string }> } }>(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?page_size=100`, {}, accessToken);
  const byName = new Map((discoveredTables.data?.items ?? []).map((item) => [item.name, item.table_id]));
  const fields: Record<string, Record<string, string>> = {};
  for (const table of MAXOPS_PORTABLE_TEMPLATE.tables) {
    const tableId = byName.get(table.name);
    if (!tableId || tableId !== tables[table.key]) throw new Error(`Provisioned table discovery mismatch: ${table.name}`);
    const discoveredFields = await feishuJson<{ data?: { items?: Array<{ field_id?: string; field_name?: string }> } }>(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?page_size=100`, {}, accessToken);
    fields[table.key] = {};
    for (const item of discoveredFields.data?.items ?? []) if (item.field_id && item.field_name) fields[table.key][item.field_name] = item.field_id;
    for (const expected of table.fields) if (!fields[table.key][expected.name]) throw new Error(`Provisioned field discovery mismatch: ${table.name}.${expected.name}`);
  }

  const taskSearch = await searchBase(accessToken, appToken, tables.tasks, [
    { field: "instance_id", value: instanceId },
    { field: "task_id", value: taskId },
  ]);
  if (taskSearch.length !== 1 || !taskSearch[0].record_id) throw new Error("Connection test task was not uniquely created");
  return { appToken, baseUrl, tables, fields, testTask: { instanceId, projectId, taskId, recordId: taskSearch[0].record_id } };
}

async function searchBase(accessToken: string, appToken: string, tableId: string, conditions: Array<{ field: string; value: string }>) {
  const response = await feishuJson<{ data?: { items?: Array<{ record_id?: string; fields?: Record<string, unknown> }> } }>(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search?page_size=20`, {
    method: "POST",
    body: JSON.stringify({ filter: { conjunction: "and", conditions: conditions.map(({ field, value }) => ({ field_name: field, operator: "is", value: [value] })) } }),
  }, accessToken);
  return response.data?.items ?? [];
}

async function createBaseRecord(accessToken: string, appToken: string, tableId: string, fields: Record<string, unknown>) {
  const response = await feishuJson<{ data?: { record?: { record_id?: string } } }>(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`, {
    method: "POST",
    body: JSON.stringify({ fields }),
  }, accessToken);
  const recordId = response.data?.record?.record_id;
  if (!recordId) throw new Error("Feishu record write returned no receipt locator");
  return recordId;
}

async function updateBaseRecord(accessToken: string, appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>) {
  await feishuJson(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  }, accessToken);
}

async function listBaseRecords(accessToken: string, appToken: string, tableId: string) {
  const items: Array<{ record_id: string; fields: Record<string, unknown> }> = [];
  let pageToken = "";
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ page_size: "200" });
    if (pageToken) query.set("page_token", pageToken);
    const payload = await feishuJson<{ data?: { items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>; has_more?: boolean; page_token?: string } }>(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?${query}`, {}, accessToken);
    for (const item of payload.data?.items ?? []) if (item.record_id) items.push({ record_id: item.record_id, fields: item.fields ?? {} });
    if (!payload.data?.has_more) return items;
    pageToken = payload.data.page_token || "";
    if (!pageToken) throw new Error("Feishu pagination did not return a cursor");
  }
  throw new Error("Feishu record listing exceeded the bounded page limit");
}

async function loadWorkspace(env: OnboardingEnv, workspaceId: string) {
  const row = await env.DB.prepare("SELECT * FROM onboarding_workspaces WHERE workspace_id = ?").bind(workspaceId).first<WorkspaceRow>();
  if (!row || row.revoked_at) return null;
  const secret = env.MAXOPS_ONBOARDING_KEY;
  if (!secret) throw new Error("Onboarding encryption unavailable");
  let payload = JSON.parse(await open(row.secret_ciphertext, secret)) as SecretPayload;
  if (payload.accessExpiresAt < Date.now() + 3 * 60_000) {
    const refreshed = await refreshAccess(env, payload.refreshToken);
    payload = {
      ...payload,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessExpiresAt: Date.now() + refreshed.expiresIn * 1000,
      refreshExpiresAt: Date.now() + refreshed.refreshExpiresIn * 1000,
    };
    await env.DB.prepare("UPDATE onboarding_workspaces SET secret_ciphertext = ?, token_expires_at = ?, refresh_expires_at = ?, updated_at = ? WHERE workspace_id = ? AND revoked_at IS NULL")
      .bind(await seal(JSON.stringify(payload), secret), payload.accessExpiresAt, payload.refreshExpiresAt, Date.now(), workspaceId).run();
  }
  return { row, secret: payload };
}

async function sessionWorkspaceId(request: Request, env: OnboardingEnv) {
  const session = parseCookies(request)[INSTALL_SESSION_COOKIE];
  if (!session || !env.MAXOPS_ONBOARDING_KEY) return null;
  try {
    const value = JSON.parse(await open(session, env.MAXOPS_ONBOARDING_KEY)) as { workspaceId?: unknown; exp?: unknown };
    return typeof value.workspaceId === "string" && typeof value.exp === "number" && value.exp > Date.now() ? value.workspaceId : null;
  } catch { return null; }
}

async function requireSession(request: Request, env: OnboardingEnv) {
  const workspaceId = await sessionWorkspaceId(request, env);
  if (!workspaceId) return null;
  return loadWorkspace(env, workspaceId);
}

async function installSessionResponse(origin: string, workspaceId: string, key: string, timestamp = Date.now()) {
  const session = await seal(JSON.stringify({ workspaceId, exp: timestamp + SESSION_TTL_MS }), key);
  const headers = new Headers({ location: `${origin}/?installed=1` });
  headers.append("set-cookie", cookie(INSTALL_SESSION_COOKIE, session, SESSION_TTL_MS / 1000));
  headers.append("set-cookie", cookie(INSTALL_STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

async function parseJsonBody(request: Request, maxBytes = 32_000) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("Request body too large");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("Request body too large");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

async function agentCredential(request: Request, env: OnboardingEnv) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (token.length < 32 || token.length > 256) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT * FROM onboarding_agent_credentials WHERE credential_hash = ?").bind(hash).first<AgentRow>();
  if (!row || row.revoked_at) return null;
  const workspace = await loadWorkspace(env, row.workspace_id);
  if (!workspace) return null;
  return { row, workspace };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function eventDigest(event: Record<string, unknown>) {
  const semantic = { ...event };
  delete semantic.event_id;
  delete semantic.occurred_at;
  return sha256(stableStringify(semantic));
}

function isoMilliseconds(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

async function connectorEvent(request: Request, env: OnboardingEnv) {
  const credential = await agentCredential(request, env);
  if (!credential) return json({ error: "Invalid Agent credential" }, { status: 401 });
  const body = await parseJsonBody(request);
  const event = body.event as Record<string, unknown> | undefined;
  const key = boundedString(body.idempotency_key, 200);
  const headerKey = request.headers.get("idempotency-key");
  if (body.schema_version !== "maxops-webhook-write/1" || !event || !key || key.length < 12 || key !== headerKey) return json({ error: "Invalid Connector envelope" }, { status: 400 });
  const { row, workspace } = credential;
  const identityOk = event.schema_version === "maxops-agent-event/1"
    && event.instance_id === workspace.secret.testTask.instanceId
    && event.task_id === row.task_id
    && event.agent_id === row.agent_id
    && event.agent_name === row.agent_name
    && typeof event.run_id === "string"
    && event.run_id.length <= 200
    && typeof event.event_id === "string"
    && event.event_id.length <= 200;
  const kind = boundedString(event.kind, 40);
  const title = boundedString(event.title, 500);
  const detail = boundedString(event.detail, 5_000);
  const occurredAt = isoMilliseconds(event.occurred_at);
  if (!identityOk || !kind || CONNECTOR_KINDS[kind] !== event.state || !title || !detail || occurredAt === null) return json({ error: "Connector identity or event semantics mismatch" }, { status: 409 });
  if (event.artifact_url) {
    try {
      const artifact = new URL(String(event.artifact_url));
      if (!new Set(["http:", "https:"]).has(artifact.protocol) || artifact.username || artifact.password || artifact.search || artifact.hash) throw new Error();
    } catch { return json({ error: "Invalid artifact URL" }, { status: 400 }); }
  }
  const digest = await eventDigest(event);
  if (body.payload_digest !== digest) return json({ error: "Connector payload digest mismatch" }, { status: 409 });
  const prior = await searchBase(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.events, [
    { field: "instance_id", value: workspace.secret.testTask.instanceId },
    { field: "idempotency_key", value: key },
  ]);
  if (prior.length > 1) return json({ error: "Stored idempotency conflict" }, { status: 409 });
  if (prior.length === 1) {
    const fields = prior[0].fields ?? {};
    if (String(fields.payload_digest ?? "") !== digest || String(fields.task_id ?? "") !== row.task_id || String(fields.agent_id ?? "") !== row.agent_id || String(fields.run_id ?? "") !== event.run_id) return json({ error: "Idempotency key already has a different payload" }, { status: 409 });
    return json({ ok: true, duplicate: true, instance_id: workspace.secret.testTask.instanceId, receipt_id: `event:${String(fields.event_id ?? event.event_id)}`, event });
  }
  await createBaseRecord(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.events, {
    "事件摘要": title,
    "任务": "连接测试",
    event_id: event.event_id,
    instance_id: workspace.secret.testTask.instanceId,
    task_id: row.task_id,
    idempotency_key: key,
    payload_digest: digest,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    run_id: event.run_id,
    kind,
    state: event.state,
    ...(event.status ? { status: event.status } : {}),
    title,
    detail,
    ...(event.artifact_url ? { artifact_url: { text: "打开产物", link: event.artifact_url } } : {}),
    occurred_at: occurredAt,
    "已读": false,
  });
  const receiptId = `event:${String(event.event_id)}`;
  await env.DB.prepare("UPDATE onboarding_agent_credentials SET last_seen_at = ?, first_receipt_id = COALESCE(first_receipt_id, ?) WHERE credential_hash = ? AND revoked_at IS NULL")
    .bind(Date.now(), receiptId, row.credential_hash).run();
  return json({ ok: true, duplicate: false, instance_id: workspace.secret.testTask.instanceId, receipt_id: receiptId, event }, { status: 201 });
}

async function connectorBootstrap(request: Request, env: OnboardingEnv) {
  const credential = await agentCredential(request, env);
  if (!credential) return json({ error: "Invalid Agent credential" }, { status: 401 });
  const { row, workspace } = credential;
  const matches = await searchBase(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.tasks, [
    { field: "instance_id", value: workspace.secret.testTask.instanceId },
    { field: "task_id", value: row.task_id },
  ]);
  if (matches.length !== 1) return json({ error: "Assigned task unavailable" }, { status: 409 });
  const fields = matches[0].fields ?? {};
  await env.DB.prepare("UPDATE onboarding_agent_credentials SET last_seen_at = ? WHERE credential_hash = ? AND revoked_at IS NULL").bind(Date.now(), row.credential_hash).run();
  return json({
    schema_version: "maxops-agent-bootstrap/1",
    connector_contract: "maxops-agent-connector/2",
    agent: { id: row.agent_id, name: row.agent_name },
    assignment: { instance_id: workspace.secret.testTask.instanceId, task_id: row.task_id, title: fields["任务名"], status: fields["五态"] },
    self_check: { required_event: "progress", expected_receipt: true },
  });
}

async function installationRoutes(request: Request, env: OnboardingEnv, url: URL) {
  const availability = onboardingAvailability(env, request);
  if (url.pathname === "/api/install/status" && request.method === "GET") {
    const workspaceId = await sessionWorkspaceId(request, env);
    return json({ ...availability, installed: Boolean(workspaceId), canary: portableCanaryMatrix() });
  }
  if (url.pathname === "/api/install/start" && request.method === "GET") {
    if (availability.state !== "ready" || !availability.origin || !env.MAXOPS_ONBOARDING_KEY || !env.MAXOPS_STORE_APP_ID) return json({ error: "Public Feishu installation is not published" }, { status: 503 });
    const redirectUri = `${availability.origin}/api/install/callback`;
    const state = await seal(JSON.stringify({ nonce: randomToken(18), exp: Date.now() + 10 * 60_000, redirectUri }), env.MAXOPS_ONBOARDING_KEY);
    const target = new URL(`${FEISHU_ACCOUNTS}/open-apis/authen/v1/authorize`);
    target.searchParams.set("client_id", env.MAXOPS_STORE_APP_ID);
    target.searchParams.set("redirect_uri", redirectUri);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("state", state);
    if (env.MAXOPS_OAUTH_SCOPES) target.searchParams.set("scope", env.MAXOPS_OAUTH_SCOPES);
    return new Response(null, { status: 302, headers: { location: target.toString(), "set-cookie": cookie(INSTALL_STATE_COOKIE, state, 600) } });
  }
  if (url.pathname === "/api/install/callback" && request.method === "GET") {
    if (availability.state !== "ready" || !availability.origin || !env.MAXOPS_ONBOARDING_KEY) return json({ error: "Public Feishu installation is not published" }, { status: 503 });
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || state !== parseCookies(request)[INSTALL_STATE_COOKIE]) return json({ error: "OAuth state expired" }, { status: 400 });
    let stateValue: { exp?: number; redirectUri?: string };
    try { stateValue = JSON.parse(await open(state, env.MAXOPS_ONBOARDING_KEY)); } catch { return json({ error: "OAuth state invalid" }, { status: 400 }); }
    if (!stateValue.exp || stateValue.exp < Date.now() || stateValue.redirectUri !== `${availability.origin}/api/install/callback`) return json({ error: "OAuth state invalid" }, { status: 400 });
    const token = await exchangeCode(env, code, stateValue.redirectUri);
    const profile = await feishuJson<{ data?: { open_id?: string; tenant_key?: string; name?: string } }>("/open-apis/authen/v1/user_info", {}, token.accessToken);
    const openId = profile.data?.open_id;
    const tenantKey = profile.data?.tenant_key;
    if (!openId || !tenantKey) return json({ error: "Feishu profile did not include tenant identity" }, { status: 400 });
    const ownerHash = await sha256(openId);
    const existing = await env.DB.prepare("SELECT * FROM onboarding_workspaces WHERE owner_hash = ? AND revoked_at IS NULL").bind(ownerHash).first<WorkspaceRow>();
    const timestamp = Date.now();
    if (existing) {
      const previous = JSON.parse(await open(existing.secret_ciphertext, env.MAXOPS_ONBOARDING_KEY)) as SecretPayload;
      const refreshed: SecretPayload = {
        ...previous,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        accessExpiresAt: timestamp + token.expiresIn * 1000,
        refreshExpiresAt: timestamp + token.refreshExpiresIn * 1000,
        ownerOpenId: openId,
        tenantKey,
      };
      await env.DB.prepare("UPDATE onboarding_workspaces SET tenant_hash = ?, display_name = ?, secret_ciphertext = ?, token_expires_at = ?, refresh_expires_at = ?, updated_at = ? WHERE workspace_id = ? AND revoked_at IS NULL")
        .bind(await sha256(tenantKey), String(profile.data?.name || "飞书用户").slice(0, 80), await seal(JSON.stringify(refreshed), env.MAXOPS_ONBOARDING_KEY), refreshed.accessExpiresAt, refreshed.refreshExpiresAt, timestamp, existing.workspace_id).run();
      return installSessionResponse(availability.origin, existing.workspace_id, env.MAXOPS_ONBOARDING_KEY, timestamp);
    }
    const provisioned = await provisionPortableBase(token.accessToken);
    const workspaceId = `workspace_${crypto.randomUUID()}`;
    const secretPayload: SecretPayload = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessExpiresAt: timestamp + token.expiresIn * 1000,
      refreshExpiresAt: timestamp + token.refreshExpiresIn * 1000,
      ownerOpenId: openId,
      tenantKey,
      ...provisioned,
    };
    await env.DB.prepare("INSERT INTO onboarding_workspaces (workspace_id, owner_hash, tenant_hash, display_name, secret_ciphertext, token_expires_at, refresh_expires_at, revoked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)")
      .bind(workspaceId, ownerHash, await sha256(tenantKey), String(profile.data?.name || "飞书用户").slice(0, 80), await seal(JSON.stringify(secretPayload), env.MAXOPS_ONBOARDING_KEY), secretPayload.accessExpiresAt, secretPayload.refreshExpiresAt, timestamp, timestamp).run();
    return installSessionResponse(availability.origin, workspaceId, env.MAXOPS_ONBOARDING_KEY, timestamp);
  }
  if (url.pathname === "/api/install/workspace" && request.method === "GET") {
    const workspace = await requireSession(request, env);
    if (!workspace) return json({ installed: false }, { status: 401 });
    const agents = await env.DB.prepare("SELECT agent_id, agent_name, task_id, revoked_at, last_seen_at, first_receipt_id, created_at FROM onboarding_agent_credentials WHERE workspace_id = ? ORDER BY created_at DESC").bind(workspace.row.workspace_id).all<AgentRow>();
    return json({
      installed: true,
      displayName: workspace.row.display_name,
      links: { feishu: "/api/install/open/feishu", dashboard: availability.origin || new URL(request.url).origin },
      connectionTest: { title: "连接测试", status: "等待 Agent 自检" },
      agents: agents.results.map((agent) => ({ id: agent.agent_id, name: agent.agent_name, connected: Boolean(agent.last_seen_at && !agent.revoked_at), receipt: agent.first_receipt_id, revoked: Boolean(agent.revoked_at) })),
    });
  }
  if (url.pathname === "/api/install/open/feishu" && request.method === "GET") {
    const workspace = await requireSession(request, env);
    if (!workspace) return json({ error: "Not authenticated" }, { status: 401 });
    return new Response(null, { status: 302, headers: { location: workspace.secret.baseUrl, "cache-control": "no-store" } });
  }
  if (url.pathname === "/api/install/dashboard" && request.method === "GET") {
    const workspace = await requireSession(request, env);
    if (!workspace) return json({ installed: false }, { status: 401 });
    const [projects, tasks, events, feedback, receipts] = await Promise.all([
      listBaseRecords(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.projects),
      listBaseRecords(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.tasks),
      listBaseRecords(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.events),
      listBaseRecords(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.feedback),
      listBaseRecords(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.receipts),
    ]);
    const projected = projectFreshBase({ projects, tasks, events, feedback, receipts });
    const writableProjects = projected.projects.map((project: { tasks: Array<Record<string, unknown>> }) => ({
      ...project,
      tasks: project.tasks.map((task) => ({ ...task, writable: true })),
    }));
    return json({
      mode: "feishu",
      authenticated: true,
      actor: workspace.row.display_name,
      source: "user-owned-install",
      ...projected,
      projects: writableProjects,
      base: {
        source: "fresh-copy",
        url: "/api/install/open/feishu",
        retrievedAt: Date.now(),
        tables: MAXOPS_PORTABLE_TEMPLATE.tables.map((table) => ({ key: table.key, id: table.key, name: table.name })),
      },
      capabilities: { sameBase: true, taskWrite: true, agentPairing: true, fakeLiveFallback: false },
    });
  }
  if (url.pathname === "/api/install/tasks/update" && request.method === "POST") {
    const workspace = await requireSession(request, env);
    if (!workspace) return json({ error: "Not authenticated" }, { status: 401 });
    const payload = await parseJsonBody(request, 4_000);
    const taskId = boundedString(payload.taskId, 200);
    const recordId = boundedString(payload.recordId, 200);
    const target = boundedString(payload.targetState, 40);
    const stateMap: Record<string, string> = { todo: "待办", open: "待办", running: "进行中", waiting: "等外部", done: "完成", abandoned: "放弃" };
    if (!taskId || !recordId || !target || !stateMap[target] || taskId !== workspace.secret.testTask.taskId || recordId !== workspace.secret.testTask.recordId) return json({ error: "Task identity mismatch" }, { status: 409 });
    const matches = await searchBase(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.tasks, [
      { field: "instance_id", value: workspace.secret.testTask.instanceId },
      { field: "task_id", value: taskId },
    ]);
    if (matches.length !== 1 || matches[0].record_id !== recordId) return json({ error: "Task identity mismatch" }, { status: 409 });
    const before = String(matches[0].fields?.["五态"] || "待办");
    await updateBaseRecord(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.tasks, recordId, { "五态": stateMap[target], updated_at: Date.now() });
    const receiptId = `receipt:${crypto.randomUUID()}`;
    await createBaseRecord(workspace.secret.accessToken, workspace.secret.appToken, workspace.secret.tables.receipts, {
      "产物名": "看板写回回执",
      "任务": "连接测试",
      receipt_id: receiptId,
      instance_id: workspace.secret.testTask.instanceId,
      task_id: taskId,
      idempotency_key: String(request.headers.get("idempotency-key") || `ui:${crypto.randomUUID()}`).slice(0, 200),
      payload_digest: await sha256(stableStringify({ taskId, before, after: stateMap[target] })),
      type: "dashboard_task_update",
      status: "acknowledged",
      "状态展示": "已写回",
      receipt: `任务状态已从「${before}」改为「${stateMap[target]}」`,
      "提交者": workspace.row.display_name,
      "说明": "漂亮看板写回同一份用户 Base",
      submitted_at: Date.now(),
      acknowledged_at: Date.now(),
    });
    return json({ ok: true, receipt: receiptId, before, after: stateMap[target] });
  }
  if (url.pathname === "/api/install/pair" && request.method === "POST") {
    const workspace = await requireSession(request, env);
    if (!workspace) return json({ error: "Install OPS first" }, { status: 401 });
    const payload = await parseJsonBody(request, 2_000);
    const agentName = normalizePortableAgentName(payload.agentName);
    const code = randomToken(24);
    const expiresAt = Date.now() + PAIR_TTL_MS;
    await env.DB.prepare("INSERT INTO onboarding_pair_codes (code_hash, workspace_id, agent_name, task_id, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)")
      .bind(await sha256(code), workspace.row.workspace_id, agentName, workspace.secret.testTask.taskId, expiresAt, Date.now()).run();
    const origin = availability.origin || new URL(request.url).origin;
    const pairingUrl = `${origin}/pair/${code}`;
    return json({ pairingUrl, expiresAt, instruction: `请接入我的 OPS 并完成连接自检：${pairingUrl}` }, { status: 201 });
  }
  const pairMatch = url.pathname.match(/^\/pair\/([A-Za-z0-9_-]{32,80})$/);
  if (pairMatch && request.method === "GET") {
    const codeHash = await sha256(pairMatch[1]);
    const pair = await env.DB.prepare("SELECT code_hash, workspace_id, agent_name, task_id, expires_at, used_at FROM onboarding_pair_codes WHERE code_hash = ?").bind(codeHash).first<PairRow>();
    if (!pair || pair.used_at || pair.expires_at <= Date.now()) return json({ error: "Pairing code expired or already used" }, { status: 410 });
    const origin = availability.origin || url.origin;
    const manifest = {
      schema_version: "maxops-pair-bootstrap/1",
      connector_contract: "maxops-agent-connector/2",
      display_name: pair.agent_name,
      exchange_url: `${origin}/pair/${pairMatch[1]}/exchange`,
      one_time: true,
      expires_at: new Date(pair.expires_at).toISOString(),
      supported_installer: { repository: "https://github.com/maxi-max-dev/ops", adapter: "webhook_write" },
    };
    if ((request.headers.get("accept") ?? "").includes("text/html")) {
      const safeName = pair.agent_name.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] || char);
      return html(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OPS Agent 配对</title><style>body{margin:0;background:#f4f6fa;color:#172033;font:15px system-ui}main{max-width:620px;margin:12vh auto;padding:32px;background:white;border:1px solid #cfd6e2;box-shadow:0 22px 60px #1d2a4424}b{color:#315bd6}code{display:block;padding:14px;background:#eef2ff;word-break:break-all}small{color:#667085}</style><main><b>OPS / ONE-TIME PAIR</b><h1>${safeName}，可以报到了</h1><p>这个地址只使用一次。支持自动安装的 Agent 应读取 JSON manifest 并调用 exchange_url；不要把返回的凭据贴回聊天。</p><code>Accept: application/json</code><small>配对后只保存 Agent 专属凭据，不会获得飞书 App Secret。</small></main></html>`);
    }
    return json(manifest);
  }
  const exchangeMatch = url.pathname.match(/^\/pair\/([A-Za-z0-9_-]{32,80})\/exchange$/);
  if (exchangeMatch && request.method === "POST") {
    const codeHash = await sha256(exchangeMatch[1]);
    const usedAt = Date.now();
    const pair = await env.DB.prepare("UPDATE onboarding_pair_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING code_hash, workspace_id, agent_name, task_id, expires_at, used_at")
      .bind(usedAt, codeHash, usedAt).first<PairRow>();
    if (!pair) return json({ error: "Pairing code expired or already used" }, { status: 410 });
    const agentToken = randomToken(32);
    const agentId = `agent_${crypto.randomUUID()}`;
    const workspace = await loadWorkspace(env, pair.workspace_id);
    if (!workspace) return json({ error: "Workspace was revoked" }, { status: 410 });
    await env.DB.prepare("INSERT INTO onboarding_agent_credentials (credential_hash, workspace_id, agent_id, agent_name, task_id, revoked_at, last_seen_at, first_receipt_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)")
      .bind(await sha256(agentToken), pair.workspace_id, agentId, pair.agent_name, pair.task_id, usedAt).run();
    const origin = availability.origin || url.origin;
    return json({
      schema_version: "maxops-pair-exchange/1",
      connector_contract: "maxops-agent-connector/2",
      credential: { type: "bearer", token: agentToken },
      bootstrap_url: `${origin}/api/install/connector/bootstrap`,
      connector: {
        repository: "https://github.com/maxi-max-dev/ops",
        adapter: "webhook_write",
        environment: {
          MAXOPS_ADAPTER: "webhook_write",
          MAXOPS_WEBHOOK_URL: `${origin}/api/install/connector/events`,
          MAXOPS_WEBHOOK_TOKEN: agentToken,
          MAXOPS_INSTANCE_ID: workspace.secret.testTask.instanceId,
          MAXOPS_TASK_ID: pair.task_id,
          MAXOPS_AGENT_ID: agentId,
          MAXOPS_AGENT_NAME: pair.agent_name,
        },
      },
      next: ["读取 bootstrap_url 的连接测试任务", "写回一条 progress", "确认返回 receipt_id"],
    }, { status: 201 });
  }
  if (url.pathname === "/api/install/connector/bootstrap" && request.method === "GET") return connectorBootstrap(request, env);
  if (url.pathname === "/api/install/connector/events" && request.method === "POST") return connectorEvent(request, env);
  const revokeAgentMatch = url.pathname.match(/^\/api\/install\/agents\/([^/]+)\/revoke$/);
  if (revokeAgentMatch && request.method === "POST") {
    const workspace = await requireSession(request, env);
    if (!workspace) return json({ error: "Not authenticated" }, { status: 401 });
    const result = await env.DB.prepare("UPDATE onboarding_agent_credentials SET revoked_at = ? WHERE workspace_id = ? AND agent_id = ? AND revoked_at IS NULL")
      .bind(Date.now(), workspace.row.workspace_id, decodeURIComponent(revokeAgentMatch[1])).run();
    return json({ ok: true, revoked: (result.meta.changes ?? 0) === 1 });
  }
  if (url.pathname === "/api/install/revoke" && request.method === "POST") {
    const workspace = await requireSession(request, env);
    if (!workspace) return json({ error: "Not authenticated" }, { status: 401 });
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE onboarding_agent_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE workspace_id = ?").bind(timestamp, workspace.row.workspace_id),
      env.DB.prepare("UPDATE onboarding_workspaces SET revoked_at = ?, updated_at = ? WHERE workspace_id = ? AND revoked_at IS NULL").bind(timestamp, timestamp, workspace.row.workspace_id),
    ]);
    return json({ ok: true, basePreserved: true }, { headers: { "set-cookie": cookie(INSTALL_SESSION_COOKIE, "", 0) } });
  }
  return json({ error: "Not found" }, { status: 404 });
}

export async function handleOneClickOnboarding(request: Request, env: OnboardingEnv, ctx: ExecutionContextLike): Promise<Response | null> {
  void ctx;
  const url = new URL(request.url);
  const matches = url.pathname.startsWith("/api/install/") || url.pathname.startsWith("/pair/");
  if (!matches) return null;
  try {
    return await installationRoutes(request, env, url);
  } catch (error) {
    console.error(JSON.stringify({ event: "onboarding_request_failed", path: url.pathname, message: error instanceof Error ? error.message : "unknown" }));
    return json({ error: "OPS installation is temporarily unavailable" }, { status: 502 });
  }
}
