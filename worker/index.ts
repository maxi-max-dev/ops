/** Cloudflare Worker entry point for OPS. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { decisionSchema, ledgerPresentation, normalizeDecision, outputText, parseFeishuText, parseGateReply, processingLeaseMs, redactError, shouldResumeQueuedCommand } from "./command-core.mjs";
import { projectFreshBase, resolveFreshTables } from "./fresh-base.mjs";
import { handleOneClickOnboarding } from "./onboarding";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FEISHU_SERVICE_APP_ID?: string;
  FEISHU_SERVICE_APP_SECRET?: string;
  FEISHU_BASE_APP_TOKEN?: string;
  FEISHU_TABLE_ID?: string;
  FEISHU_TASK_SCHEMA?: string;
  MAXOPS_FRESH_BASE_APP_TOKEN?: string;
  MAXOPS_FRESH_BASE_URL?: string;
  FEISHU_H5_APP_ID?: string;
  FEISHU_H5_APP_SECRET?: string;
  FEISHU_EVENT_VERIFICATION_TOKEN?: string;
  FEISHU_ALLOWED_OPEN_ID_HASHES?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  MAXOPS_MODEL_PROXY_URL?: string;
  MAXOPS_MODEL_PROXY_TOKEN?: string;
  MAXOPS_FEISHU_CONNECTOR_TOKEN?: string;
  COMMAND_PROCESSING_LEASE_MS?: string;
  PROJECTION_LEASE_MS?: string;
  NOTIFICATION_LEASE_MS?: string;
  NOTIFICATION_SEND_TIMEOUT_MS?: string;
  MAXOPS_INGEST_TOKEN?: string;
  MAXOPS_AGENT_TOKEN?: string;
  MAXOPS_AGENT_ALLOW_GLOBAL_TOKEN?: string;
  MAXOPS_AGENT_TASK_CREDENTIALS_JSON?: string;
  MAXOPS_STORE_APP_ID?: string;
  MAXOPS_STORE_APP_SECRET?: string;
  MAXOPS_ONBOARDING_KEY?: string;
  MAXOPS_INSTALL_PUBLIC_ORIGIN?: string;
  MAXOPS_OAUTH_SCOPES?: string;
  MAXOPS_ONBOARDING_ONLY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type Actor = { openId: string; name: string; exp?: number };
type FeishuRecord = { record_id: string; fields: Record<string, unknown> };
type FeishuTable = { table_id: string; name: string };
type TaskStage = "todo" | "running" | "waiting" | "done" | "abandoned" | "open";
type TaskCandidate = {
  recordId: string;
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  done: boolean;
  stage: TaskStage;
};
type CommandRow = {
  command_id: string;
  idempotency_key: string;
  source: string;
  source_event_id: string | null;
  actor_hash: string;
  actor_name: string | null;
  raw_input: string;
  intent: string | null;
  task_id: string | null;
  record_id: string | null;
  target_state: string | null;
  confidence: number | null;
  reason: string | null;
  status: string;
  expected_version: number | null;
  claimed_version: number | null;
  run_id: string;
  receipt_id: string | null;
  projection_applied_at: number | null;
  projection_token: string | null;
  projection_lease_until: number | null;
  processing_token: string | null;
  processing_lease_until: number | null;
  processing_stage: string | null;
  model_provider: string | null;
  model_name: string | null;
  model_response_id: string | null;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  confirmed_at: number | null;
  completed_at: number | null;
};
type EntityRow = { task_id: string; record_id: string; state: number; stage: TaskStage; version: number; causation_id: string | null; updated_at: number };
type ReceiptRow = {
  receipt_id: string;
  command_id: string;
  run_id: string;
  status: string;
  task_id: string;
  entity_version: number;
  before_json: string;
  after_json: string;
  notification_status: string;
  created_at: number;
};
type NotificationRow = {
  notification_id: string;
  command_id: string;
  run_id: string;
  kind: string;
  recipient_ciphertext: string;
  body_text: string;
  status: string;
  attempts: number;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
};
type SourceEventRow = {
  source_event_id: string;
  source: string;
  occurred_at: number;
  actor: string;
  title: string;
  status: string;
  detail: string;
  source_path: string;
  source_hash: string;
  task_id: string | null;
  created_at: number;
};
type AgentEventRow = {
  event_id: string;
  idempotency_key: string;
  run_id: string;
  agent_id: string;
  agent_name: string;
  task_id: string | null;
  record_id: string | null;
  payload_fingerprint: string | null;
  kind: string;
  state: string;
  title: string;
  detail: string;
  artifact_url: string | null;
  occurred_at: number;
  created_at: number;
};
type AgentMessageRow = {
  message_id: string;
  idempotency_key: string;
  task_id: string;
  record_id: string | null;
  run_id: string | null;
  agent_id: string;
  direction: string;
  kind: string;
  body: string;
  in_reply_to: string | null;
  status: string;
  created_by: string;
  note_marker: string | null;
  payload_fingerprint: string | null;
  created_at: number;
  delivered_at: number | null;
  acknowledged_at: number | null;
};
type AgentReceiptRow = {
  receipt_id: string;
  idempotency_key: string;
  subject_type: string;
  subject_id: string;
  agent_id: string;
  kind: string;
  before_json: string;
  after_json: string;
  payload_fingerprint: string | null;
  created_at: number;
};
type FeishuEventReceiptRow = {
  event_id: string;
  payload_fingerprint: string;
  event_type: string;
  message_id: string | null;
  status: string;
  command_id: string | null;
  run_id: string | null;
  created_at: number;
};
type AgentCredential =
  | { mode: "task"; agentId: string; taskId: string; recordId: string }
  | { mode: "global" };

const SESSION_COOKIE = "max_ops_feishu";
const STATE_COOKIE = "max_ops_oauth_state";

class RecoverableProjectionError extends Error {
  ownerToken?: string | null;

  constructor(message: string, ownerToken?: string | null) {
    super(message);
    this.ownerToken = ownerToken;
  }
}

class IdempotencyPayloadConflictError extends Error {}

function now() {
  return Date.now();
}

function projectionLeaseMs(env: Env) {
  return Math.max(100, Number(env.PROJECTION_LEASE_MS) || 5_000);
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function required(env: Env, key: keyof Env) {
  const value = env[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing ${String(key)}`);
  return value;
}

function cookies(request: Request) {
  return Object.fromEntries((request.headers.get("cookie") ?? "").split(";").map((part) => {
    const [name, ...value] = part.trim().split("=");
    return [name, decodeURIComponent(value.join("="))];
  }).filter(([name]) => name));
}

function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sessionKey(secret: string, usages: KeyUsage[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`max-ops-session:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, usages);
}

async function sha256(value: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function fixedEqual(left: string, right: string) {
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)), crypto.subtle.digest("SHA-256", new TextEncoder().encode(right))]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < aa.length; index += 1) difference |= aa[index] ^ bb[index];
  return difference === 0;
}

function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function boundedJson(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  if (!request.body) throw new Error("Request body is required");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Request body is too large");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function cleanString(value: unknown, name: string, maxLength: number, requiredValue = true) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const cleaned = value.trim();
  if ((requiredValue && !cleaned) || cleaned.length > maxLength) throw new Error(`Invalid ${name}`);
  return cleaned;
}

function requestIdempotencyKey(request: Request, namespace: string) {
  const key = cleanString(request.headers.get("idempotency-key"), "Idempotency-Key", 200);
  if (key.length < 12 || /[\r\n]/.test(key)) throw new Error("Invalid Idempotency-Key");
  return `${namespace}:${key}`;
}

function agentTaskCredentials(env: Env) {
  if (env.MAXOPS_AGENT_TASK_CREDENTIALS_JSON === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(env.MAXOPS_AGENT_TASK_CREDENTIALS_JSON); } catch { throw new Error("Invalid agent credential configuration"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) throw new Error("Invalid agent credential configuration");
  const hashes = new Set<string>();
  try {
    return parsed.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid");
      const value = entry as Record<string, unknown>;
      const tokenHash = cleanString(value.token_sha256, "token_sha256", 43);
      const agentId = cleanString(value.agent_id, "agent_id", 120);
      const taskId = cleanString(value.task_id, "task_id", 200);
      const recordId = cleanString(value.record_id, "record_id", 200);
      if (!/^[A-Za-z0-9_-]{43}$/.test(tokenHash) || hashes.has(tokenHash)) throw new Error("invalid");
      hashes.add(tokenHash);
      return { tokenHash, agentId, taskId, recordId };
    });
  } catch {
    throw new Error("Invalid agent credential configuration");
  }
}

async function authenticateAgent(request: Request, env: Env): Promise<AgentCredential> {
  const token = bearer(request);
  if (!token) throw new Error("Invalid agent token");
  const scoped = agentTaskCredentials(env);
  if (scoped) {
    const tokenHash = await sha256(token);
    for (const candidate of scoped) {
      if (await fixedEqual(tokenHash, candidate.tokenHash)) {
        return { mode: "task", agentId: candidate.agentId, taskId: candidate.taskId, recordId: candidate.recordId };
      }
    }
    // A configured scoped-token set is an authorization boundary. Never fall
    // through to a broader token when it is present but does not match.
    throw new Error("Invalid agent token");
  }
  if (env.MAXOPS_AGENT_ALLOW_GLOBAL_TOKEN === "true" && env.MAXOPS_AGENT_TOKEN
    && await fixedEqual(token, env.MAXOPS_AGENT_TOKEN)) return { mode: "global" };
  throw new Error("Invalid agent token");
}

function assertAgentScope(credential: AgentCredential, scope: { agentId?: string; taskId?: string; recordId?: string }) {
  if (credential.mode === "global") return;
  if ((scope.agentId !== undefined && scope.agentId !== credential.agentId)
    || (scope.taskId !== undefined && scope.taskId !== credential.taskId)
    || (scope.recordId !== undefined && scope.recordId !== credential.recordId)) {
    throw new Error("Agent credential scope denied");
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

async function payloadFingerprint(namespace: string, values: unknown[]) {
  return sha256(`${namespace}\n${canonicalJson(values)}`);
}

function assertIdempotentPayload(stored: string | null, candidate: string) {
  if (!stored || stored !== candidate) throw new IdempotencyPayloadConflictError("Idempotency payload conflict");
}

async function createSession(actor: Actor, secret: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({ ...actor, exp: now() + 7 * 24 * 60 * 60 * 1000 }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await sessionKey(secret, ["encrypt"]), plaintext);
  return `${base64Url(nonce)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function sealStoredValue(value: string, secret: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await sessionKey(secret, ["encrypt"]), new TextEncoder().encode(value));
  return `${base64Url(nonce)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function openStoredValue(value: string, secret: string) {
  const [nonceValue, ciphertextValue] = value.split(".");
  if (!nonceValue || !ciphertextValue) throw new Error("Stored recipient is invalid");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(nonceValue) },
    await sessionKey(secret, ["decrypt"]),
    decodeBase64Url(ciphertextValue),
  );
  return new TextDecoder().decode(plaintext);
}

async function readSession(request: Request, secret: string): Promise<Actor | null> {
  const token = cookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const [nonceValue, ciphertextValue] = token.split(".");
  if (!nonceValue || !ciphertextValue) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64Url(nonceValue) },
      await sessionKey(secret, ["decrypt"]),
      decodeBase64Url(ciphertextValue),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Actor & { exp: number };
    return parsed.exp > now() && parsed.openId ? parsed : null;
  } catch {
    return null;
  }
}

async function actorHash(actor: Actor | string) {
  return sha256(typeof actor === "string" ? actor : actor.openId);
}

async function assertAllowed(actor: Actor | string, env: Env) {
  const supplied = await actorHash(actor);
  const allowed = required(env, "FEISHU_ALLOWED_OPEN_ID_HASHES").split(",").map((item) => item.trim()).filter(Boolean);
  for (const expected of allowed) if (await fixedEqual(supplied, expected)) return supplied;
  throw new Error("Actor is not allowlisted");
}

async function feishu<T>(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const body = await response.json() as T & { code?: number; msg?: string };
  if (!response.ok || (typeof body.code === "number" && body.code !== 0)) throw new Error(`Feishu request failed (${response.status}/${body.code ?? "http"})`);
  return body;
}

async function appAccessToken(appId: string, appSecret: string) {
  const body = await feishu<{ app_access_token: string }>("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  return body.app_access_token;
}

async function tenantAccessToken(appId: string, appSecret: string) {
  const body = await feishu<{ tenant_access_token: string }>("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  return body.tenant_access_token;
}

async function baseToken(env: Env) {
  return tenantAccessToken(required(env, "FEISHU_SERVICE_APP_ID"), required(env, "FEISHU_SERVICE_APP_SECRET"));
}

async function botToken(env: Env) {
  return tenantAccessToken(required(env, "FEISHU_H5_APP_ID"), required(env, "FEISHU_H5_APP_SECRET"));
}

function recordBase(env: Env) {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(required(env, "FEISHU_BASE_APP_TOKEN"))}/tables/${encodeURIComponent(required(env, "FEISHU_TABLE_ID"))}/records`;
}

function usesWarBoard(env: Env) {
  return env.FEISHU_TASK_SCHEMA === "war_board";
}

async function listBaseRecords(env: Env) {
  const response = await feishu<{ data: { items: FeishuRecord[] } }>(`${recordBase(env)}?page_size=200&automatic_fields=true`, {
    headers: { authorization: `Bearer ${await baseToken(env)}` },
  });
  return response.data.items ?? [];
}

function freshBaseUrl(env: Env) {
  const value = env.MAXOPS_FRESH_BASE_URL?.trim();
  if (!value) throw new Error("Missing MAXOPS_FRESH_BASE_URL");
  return value;
}

async function listFreshTables(env: Env, token: string) {
  const appToken = required(env, "MAXOPS_FRESH_BASE_APP_TOKEN");
  const response = await feishu<{ data: { items: FeishuTable[] } }>(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?page_size=100`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return response.data.items ?? [];
}

async function listFreshTableRecords(env: Env, token: string, tableId: string) {
  const appToken = required(env, "MAXOPS_FRESH_BASE_APP_TOKEN");
  const items: FeishuRecord[] = [];
  let pageToken = "";
  do {
    const url = new URL(`https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`);
    url.searchParams.set("page_size", "500");
    url.searchParams.set("automatic_fields", "true");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await feishu<{ data: { items: FeishuRecord[]; has_more?: boolean; page_token?: string } }>(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    items.push(...(response.data.items ?? []));
    pageToken = response.data.has_more ? response.data.page_token ?? "" : "";
  } while (pageToken);
  return items;
}

async function freshBaseState(env: Env) {
  const token = await baseToken(env);
  const allTables = await listFreshTables(env, token);
  const resolved = resolveFreshTables(allTables) as {
    tables: Record<string, FeishuTable>;
    missing: string[];
  };
  if (resolved.missing.length) throw new Error(`OPS fresh copy is missing required tables: ${resolved.missing.join(", ")}`);
  const entries = await Promise.all(Object.entries(resolved.tables).map(async ([key, table]) => [key, await listFreshTableRecords(env, token, table.table_id)] as const));
  const snapshot = Object.fromEntries(entries) as Record<string, FeishuRecord[]>;
  const projection = projectFreshBase(snapshot);
  if (!projection.projects.length || !projection.projects.some((project: { tasks?: unknown[] }) => project.tasks?.length)) {
    throw new Error("OPS fresh copy returned no project-linked tasks");
  }
  return {
    ...projection,
    base: {
      source: "fresh-copy",
      url: freshBaseUrl(env),
      retrievedAt: now(),
      tables: Object.entries(resolved.tables).map(([key, table]) => ({ key, id: table.table_id, name: table.name })),
    },
  };
}

async function getBaseRecord(env: Env, recordId: string) {
  const response = await feishu<{ data: { record: FeishuRecord } }>(`${recordBase(env)}/${encodeURIComponent(recordId)}`, {
    headers: { authorization: `Bearer ${await baseToken(env)}` },
  });
  return response.data.record;
}

function normalizedTargetStage(value: string): TaskStage {
  if (value === "open") return "open";
  if (["todo", "running", "waiting", "done", "abandoned"].includes(value)) return value as TaskStage;
  throw new Error("Unsupported task stage");
}

function stageFromFields(fields: Record<string, unknown>): TaskStage {
  const stage = fieldText(fields["阶段"]);
  if (stage.includes("完成")) return "done";
  if (stage.includes("放弃")) return "abandoned";
  if (stage.includes("进行中")) return "running";
  if (stage.includes("等外部")) return "waiting";
  if (stage.includes("待办")) return "todo";
  return fields["完成"] ? "done" : "open";
}

function stageFieldValue(stage: TaskStage) {
  if (stage === "done") return "✅完成";
  if (stage === "abandoned") return "🛑放弃";
  if (stage === "running") return "🚧进行中";
  if (stage === "waiting") return "⏳等外部";
  return "📥待办";
}

function stageDisplay(stage: TaskStage) {
  if (stage === "done") return "完成";
  if (stage === "abandoned") return "放弃";
  if (stage === "running") return "进行中";
  if (stage === "waiting") return "等外部";
  return "待办";
}

function taskIdForRecord(record: FeishuRecord) {
  return fieldText(record.fields.task_id, record.record_id);
}

function projectionMarker(env: Env, record: FeishuRecord, source: string) {
  return usesWarBoard(env) ? fieldText(record.fields["备注"]).includes(source) : fieldText(record.fields["更新来源"]) === source;
}

async function writeBaseRecord(env: Env, recordId: string, targetState: string, source: string, audit?: { rawInput?: string | null; reason?: string | null }) {
  const targetStage = normalizedTargetStage(targetState);
  let fields: Record<string, unknown>;
  if (usesWarBoard(env)) {
    const current = await getBaseRecord(env, recordId);
    const before = stageFromFields(current.fields);
    const existingNote = fieldText(current.fields["备注"]);
    const timestamp = new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai",
    }).format(new Date()).replaceAll("/", "-");
    const reason = fieldText(audit?.reason, "OPS 根据已确认命令更新任务状态").replaceAll("\n", " ");
    const quote = fieldText(audit?.rawInput, "系统恢复已确认写回").replaceAll("\n", " ");
    const line = `[${timestamp}｜OPS] 阶段：${stageDisplay(before)}→${stageDisplay(targetStage)}；原因：${reason}；依据：用户说“${quote}”；${source}`;
    fields = { "阶段": stageFieldValue(targetStage), "备注": [existingNote.trim(), line].filter(Boolean).join("\n") };
  } else {
    if (!["done", "open", "todo"].includes(targetStage)) throw new Error("This Base schema only supports done/open");
    fields = { "完成": targetStage === "done", "更新时间": now(), "更新来源": source };
  }
  await feishu(`${recordBase(env)}/${encodeURIComponent(recordId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${await baseToken(env)}` },
    body: JSON.stringify({ fields }),
  });
}

async function sendBotText(env: Env, openId: string, text: string, uuid?: string) {
  await feishu("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await botToken(env)}` },
    body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }), ...(uuid ? { uuid } : {}) }),
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function notificationValues(env: Env, row: Pick<CommandRow, "command_id" | "run_id">, kind: string, openId: string, text: string) {
  return {
    notificationId: `ntf_${(await sha256(`${row.command_id}:${kind}`)).slice(0, 40)}`,
    recipient: await sealStoredValue(openId, required(env, "FEISHU_H5_APP_SECRET")),
    text,
  };
}

function notificationInsert(env: Env, row: Pick<CommandRow, "command_id" | "run_id">, kind: string, values: { notificationId: string; recipient: string; text: string }, stamp: number, requiredStatus: string) {
  return env.DB.prepare(`INSERT OR IGNORE INTO notification_outbox
    (notification_id, command_id, run_id, kind, recipient_ciphertext, body_text, status, attempts, lease_until, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?
    WHERE EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = ?)`)
    .bind(values.notificationId, row.command_id, row.run_id, kind, values.recipient, values.text, stamp, stamp, row.command_id, requiredStatus);
}

async function enqueueNotification(env: Env, row: Pick<CommandRow, "command_id" | "run_id">, kind: string, openId: string, text: string) {
  const values = await notificationValues(env, row, kind, openId, text);
  const stamp = now();
  await env.DB.prepare(`INSERT OR IGNORE INTO notification_outbox
    (notification_id, command_id, run_id, kind, recipient_ciphertext, body_text, status, attempts, lease_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`).bind(values.notificationId, row.command_id, row.run_id, kind, values.recipient, text, stamp, stamp).run();
  return values.notificationId;
}

async function flushNotification(env: Env, notificationId: string) {
  const notificationLeaseMs = Math.max(100, Number(env.NOTIFICATION_LEASE_MS) || 1_000);
  let existing = await env.DB.prepare("SELECT * FROM notification_outbox WHERE notification_id = ?").bind(notificationId).first<NotificationRow>();
  if (!existing || existing.status === "sent") return existing?.status === "sent";
  if (existing.status === "sending" && (existing.lease_until ?? 0) > now()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(notificationLeaseMs, (existing!.lease_until ?? now()) - now() + 10)));
    existing = await env.DB.prepare("SELECT * FROM notification_outbox WHERE notification_id = ?").bind(notificationId).first<NotificationRow>();
    if (!existing || existing.status === "sent") return existing?.status === "sent";
  }
  const stamp = now();
  const claimed = await env.DB.prepare(`UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, lease_until = ?, updated_at = ?
    WHERE notification_id = ? AND (status IN ('pending', 'failed') OR (status = 'sending' AND COALESCE(lease_until, 0) <= ?))`)
    .bind(stamp + notificationLeaseMs, stamp, notificationId, stamp).run();
  if ((claimed.meta.changes ?? 0) !== 1) return false;
  const row = await env.DB.prepare("SELECT * FROM notification_outbox WHERE notification_id = ?").bind(notificationId).first<NotificationRow>();
  if (!row) return false;
  try {
    const openId = await openStoredValue(row.recipient_ciphertext, required(env, "FEISHU_H5_APP_SECRET"));
    const body = row.kind === "terminal_success" ? await successNotificationText(env, row.command_id, row.body_text) : row.body_text;
    const sendTimeoutMs = Math.max(100, Number(env.NOTIFICATION_SEND_TIMEOUT_MS) || 3_000);
    await withTimeout(sendBotText(env, openId, body, row.notification_id), sendTimeoutMs, "Feishu notification timed out");
    const completed = now();
    const statements = [env.DB.prepare("UPDATE notification_outbox SET status = 'sent', lease_until = NULL, updated_at = ? WHERE notification_id = ? AND status = 'sending'").bind(completed, notificationId)];
    if (row.kind.startsWith("terminal_")) {
      statements.push(env.DB.prepare("UPDATE receipts SET notification_status = 'sent' WHERE command_id = ?").bind(row.command_id));
    }
    await env.DB.batch(statements);
    return true;
  } catch (error) {
    try {
      await env.DB.prepare("UPDATE notification_outbox SET status = 'failed', lease_until = NULL, updated_at = ? WHERE notification_id = ? AND status = 'sending'")
        .bind(now(), notificationId).run();
      if (row.kind.startsWith("terminal_")) {
        await env.DB.prepare("UPDATE receipts SET notification_status = 'failed' WHERE command_id = ? AND notification_status != 'sent'").bind(row.command_id).run();
      }
    } catch (statusError) {
      console.error(JSON.stringify({ event: "notification_outbox_status_failed", commandId: row.command_id, message: redactError(statusError) }));
    }
    console.error(JSON.stringify({ event: "notification_outbox_delivery_failed", commandId: row.command_id, kind: row.kind, message: redactError(error) }));
    return false;
  }
}

async function notifyDurably(env: Env, row: Pick<CommandRow, "command_id" | "run_id">, kind: string, openId: string, text: string) {
  const notificationId = await enqueueNotification(env, row, kind, openId, text);
  return flushNotification(env, notificationId);
}

async function flushCommandNotifications(env: Env, commandId: string) {
  const pending = await env.DB.prepare("SELECT notification_id FROM notification_outbox WHERE command_id = ? AND status != 'sent' ORDER BY created_at")
    .bind(commandId).all<{ notification_id: string }>();
  for (const item of pending.results) await flushNotification(env, item.notification_id);
}

async function notificationRecipient(env: Env, commandId: string) {
  const row = await env.DB.prepare("SELECT recipient_ciphertext FROM notification_outbox WHERE command_id = ? ORDER BY created_at LIMIT 1")
    .bind(commandId).first<{ recipient_ciphertext: string }>();
  if (!row) return null;
  try {
    return await openStoredValue(row.recipient_ciphertext, required(env, "FEISHU_H5_APP_SECRET"));
  } catch (error) {
    console.error(JSON.stringify({ event: "notification_recipient_open_failed", commandId, message: redactError(error) }));
    return null;
  }
}

async function renewProjectionLease(env: Env, commandId: string, ownerToken: string) {
  const stamp = now();
  const renewed = await env.DB.prepare(`UPDATE commands SET projection_lease_until = ?, updated_at = ?
    WHERE command_id = ? AND status = 'projection_inflight' AND projection_token = ?`)
    .bind(stamp + projectionLeaseMs(env), stamp, commandId, ownerToken).run();
  return (renewed.meta.changes ?? 0) === 1;
}

function startProjectionHeartbeat(env: Env, row: CommandRow, ownerToken: string) {
  const intervalMs = Math.max(25, Math.floor(projectionLeaseMs(env) / 3));
  const timer = setInterval(() => {
    void renewProjectionLease(env, row.command_id, ownerToken).catch((error) => {
      console.error(JSON.stringify({ event: "projection_lease_renew_failed", commandId: row.command_id, message: redactError(error) }));
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

async function expireModelInflight(env: Env, row: CommandRow, openId: string) {
  const stamp = now();
  const text = `⚠️ AI 调用结果无法确认，没有写回。请重新发送一条命令。\nrun: ${row.run_id}`;
  const values = await notificationValues(env, row, "model_outcome_unknown", openId, text);
  const fenced = await env.DB.batch([
    env.DB.prepare(`UPDATE commands SET status = 'needs_input', processing_token = NULL, processing_lease_until = NULL, processing_stage = NULL,
      reason = 'AI 调用超时，结果无法确认；没有写回，请发起一条新命令', updated_at = ?
      WHERE command_id = ? AND status = 'processing' AND processing_stage = 'model_inflight' AND COALESCE(processing_lease_until, 0) <= ?`)
      .bind(stamp, row.command_id, stamp),
    env.DB.prepare(`UPDATE runs SET status = 'needs_input' WHERE run_id = ?
      AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'needs_input')`).bind(row.run_id, row.command_id),
    notificationInsert(env, row, "model_outcome_unknown", values, stamp, "needs_input"),
  ]);
  if ((fenced[0].meta.changes ?? 0) !== 1) return false;
  try { await appendEvent(env, row.command_id, row.run_id, "model_outcome_unknown", { message: "AI 调用跨越处理租约，已阻止二次调用" }); } catch { /* Display-only. */ }
  return true;
}

async function recoverDurableWork(env: Env) {
  const resumableRouting = await env.DB.prepare(`SELECT * FROM commands
    WHERE status = 'queued' OR (status = 'processing' AND processing_stage = 'routing' AND COALESCE(processing_lease_until, 0) <= ?)
    ORDER BY updated_at LIMIT 20`).bind(now()).all<CommandRow>();
  for (const row of resumableRouting.results) {
    const openId = await notificationRecipient(env, row.command_id);
    if (!openId) continue;
    try {
      await processNewFeishuCommand(env, row, openId);
    } catch (error) {
      console.error(JSON.stringify({ event: "durable_routing_recovery_failed", commandId: row.command_id, message: redactError(error) }));
    }
  }

  const expiredModels = await env.DB.prepare(`SELECT * FROM commands
    WHERE status = 'processing' AND processing_stage = 'model_inflight' AND COALESCE(processing_lease_until, 0) <= ?
    ORDER BY updated_at LIMIT 20`).bind(now()).all<CommandRow>();
  for (const row of expiredModels.results) {
    const openId = await notificationRecipient(env, row.command_id);
    if (openId) await expireModelInflight(env, row, openId);
  }

  const expiredProjections = await env.DB.prepare(`SELECT * FROM commands
    WHERE status = 'projection_inflight' AND COALESCE(projection_lease_until, 0) <= ?
    ORDER BY updated_at LIMIT 20`).bind(now()).all<CommandRow>();
  for (const row of expiredProjections.results) {
    const openId = await notificationRecipient(env, row.command_id);
    try {
      await executeCommand(env, row.command_id, openId ?? undefined);
    } catch (error) {
      console.error(JSON.stringify({ event: "durable_projection_recovery_failed", commandId: row.command_id, message: redactError(error) }));
    }
  }

  const executable = await env.DB.prepare("SELECT * FROM commands WHERE status IN ('confirmed', 'projection_prepared') ORDER BY updated_at LIMIT 20")
    .all<CommandRow>();
  for (const row of executable.results) {
    const openId = await notificationRecipient(env, row.command_id);
    if (!openId) continue;
    try {
      await executeApprovedCommand(env, row, openId);
    } catch (error) {
      console.error(JSON.stringify({ event: "durable_command_recovery_failed", commandId: row.command_id, message: redactError(error) }));
    }
  }

  const notifications = await env.DB.prepare("SELECT notification_id FROM notification_outbox WHERE status != 'sent' ORDER BY updated_at LIMIT 50")
    .all<{ notification_id: string }>();
  await Promise.allSettled(notifications.results.map((item) => flushNotification(env, item.notification_id)));
}

function fieldText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => fieldText(item)).filter(Boolean).join("、");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return fieldText(item.text ?? item.name ?? item.value, fallback);
  }
  return fallback;
}

function dueText(value: unknown) {
  const raw = fieldText(value, "持续");
  const timestamp = Number(raw);
  if (!Number.isFinite(timestamp) || timestamp < 1_000_000_000_000) return raw;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric", day: "numeric", timeZone: "Asia/Shanghai",
  }).format(new Date(timestamp));
}

function receiptJson(row: AgentReceiptRow | null) {
  if (!row) return null;
  const parse = (value: string) => {
    try { return JSON.parse(value) as unknown; } catch { return value; }
  };
  return {
    receipt_id: row.receipt_id,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    agent_id: row.agent_id,
    kind: row.kind,
    before: parse(row.before_json),
    after: parse(row.after_json),
    created_at: row.created_at,
  };
}

function messageJson(row: AgentMessageRow) {
  return {
    message_id: row.message_id,
    task_id: row.task_id,
    record_id: row.record_id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    direction: row.direction,
    kind: row.kind,
    body: row.body,
    in_reply_to: row.in_reply_to,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    acknowledged_at: row.acknowledged_at,
  };
}

async function agentReceiptByKey(env: Env, idempotencyKey: string) {
  return env.DB.prepare("SELECT * FROM agent_receipts WHERE idempotency_key = ?").bind(idempotencyKey).first<AgentReceiptRow>();
}

async function assertTaskReference(env: Env, taskId: string, recordId: string) {
  const record = await getBaseRecord(env, recordId);
  if (taskIdForRecord(record) !== taskId) throw new Error("Task identity mismatch");
  return record;
}

function validateAgentState(value: unknown) {
  const state = cleanString(value, "state", 20);
  if (!new Set(["running", "waiting", "blocked", "done", "failed"]).has(state)) throw new Error("Unsupported agent state");
  return state;
}

function validateAgentKind(value: unknown) {
  const kind = cleanString(value, "kind", 40);
  if (!new Set(["run_started", "progress", "blocked", "artifact", "run_finished", "heartbeat"]).has(kind)) throw new Error("Unsupported agent event kind");
  return kind;
}

function validateArtifactUrl(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const candidate = cleanString(value, "artifact_url", 1000);
  const url = new URL(candidate);
  if (!new Set(["https:", "http:"]).has(url.protocol)) throw new Error("artifact_url must use http or https");
  return url.toString();
}

async function createAgentEvent(request: Request, env: Env, credential: AgentCredential) {
  const payload = await boundedJson(request);
  const key = requestIdempotencyKey(request, "agent-event");
  const agentId = cleanString(payload.agent_id, "agent_id", 120);
  const agentName = cleanString(payload.agent_name, "agent_name", 200);
  const runId = cleanString(payload.run_id, "run_id", 200);
  const taskId = cleanString(payload.task_id, "task_id", 200);
  const recordId = cleanString(payload.record_id, "record_id", 200);
  const kind = validateAgentKind(payload.kind);
  const state = validateAgentState(payload.state);
  const title = cleanString(payload.title, "title", 300);
  const detail = cleanString(payload.detail, "detail", 4000, false);
  const artifactUrl = validateArtifactUrl(payload.artifact_url);
  const occurredAt = payload.occurred_at === undefined ? now() : Number(payload.occurred_at);
  if (!Number.isFinite(occurredAt) || occurredAt < 0 || occurredAt > now() + 5 * 60_000) throw new Error("Invalid occurred_at");
  assertAgentScope(credential, { agentId, taskId, recordId });
  const fingerprint = await payloadFingerprint("agent-event", [agentId, agentName, runId, taskId, recordId, kind, state, title, detail, artifactUrl, payload.occurred_at === undefined ? null : occurredAt]);
  await assertTaskReference(env, taskId, recordId);

  const existing = await env.DB.prepare("SELECT * FROM agent_events WHERE idempotency_key = ?").bind(key).first<AgentEventRow>();
  if (existing) {
    assertIdempotentPayload(existing.payload_fingerprint, fingerprint);
    return { created: false, event: existing, receipt: await agentReceiptByKey(env, `receipt:${key}`) };
  }

  const eventId = id("aevt");
  const receiptId = id("arct");
  const stamp = now();
  const after = { stored: true, event_id: eventId, run_id: runId, state };
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO agent_events
        (event_id, idempotency_key, run_id, agent_id, agent_name, task_id, record_id, payload_fingerprint, kind, state, title, detail, artifact_url, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(eventId, key, runId, agentId, agentName, taskId, recordId, fingerprint, kind, state, title, detail, artifactUrl, occurredAt, stamp),
      env.DB.prepare(`INSERT INTO agent_receipts
        (receipt_id, idempotency_key, subject_type, subject_id, agent_id, kind, before_json, after_json, payload_fingerprint, created_at)
        VALUES (?, ?, 'event', ?, ?, 'stored', '{}', ?, ?, ?)`)
        .bind(receiptId, `receipt:${key}`, eventId, agentId, JSON.stringify(after), fingerprint, stamp),
    ]);
  } catch (error) {
    const raced = await env.DB.prepare("SELECT * FROM agent_events WHERE idempotency_key = ?").bind(key).first<AgentEventRow>();
    if (!raced) throw error;
    assertIdempotentPayload(raced.payload_fingerprint, fingerprint);
    return { created: false, event: raced, receipt: await agentReceiptByKey(env, `receipt:${key}`) };
  }
  const event = await env.DB.prepare("SELECT * FROM agent_events WHERE event_id = ?").bind(eventId).first<AgentEventRow>();
  return { created: true, event, receipt: await agentReceiptByKey(env, `receipt:${key}`) };
}

async function createAgentQuestion(request: Request, env: Env, credential: AgentCredential) {
  const payload = await boundedJson(request);
  const key = requestIdempotencyKey(request, "agent-question");
  const agentId = cleanString(payload.agent_id, "agent_id", 120);
  const agentName = cleanString(payload.agent_name, "agent_name", 200);
  const runId = cleanString(payload.run_id, "run_id", 200);
  const taskId = cleanString(payload.task_id, "task_id", 200);
  const recordId = cleanString(payload.record_id, "record_id", 200);
  const question = cleanString(payload.question, "question", 4000);
  assertAgentScope(credential, { agentId, taskId, recordId });
  const fingerprint = await payloadFingerprint("agent-question", [agentId, agentName, runId, taskId, recordId, question]);
  await assertTaskReference(env, taskId, recordId);

  const existing = await env.DB.prepare("SELECT * FROM agent_messages WHERE idempotency_key = ?").bind(key).first<AgentMessageRow>();
  if (existing) {
    assertIdempotentPayload(existing.payload_fingerprint, fingerprint);
    return { created: false, message: existing, receipt: await agentReceiptByKey(env, `receipt:${key}`) };
  }

  const messageId = id("amsg");
  const receiptId = id("arct");
  const stamp = now();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO agent_messages
        (message_id, idempotency_key, task_id, record_id, run_id, agent_id, direction, kind, body, in_reply_to, status, created_by, note_marker, payload_fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'to_max', 'question', ?, NULL, 'pending', ?, NULL, ?, ?)`)
        .bind(messageId, key, taskId, recordId, runId, agentId, question, `agent:${agentName}`, fingerprint, stamp),
      env.DB.prepare(`INSERT INTO agent_receipts
        (receipt_id, idempotency_key, subject_type, subject_id, agent_id, kind, before_json, after_json, payload_fingerprint, created_at)
        VALUES (?, ?, 'message', ?, ?, 'stored', '{}', ?, ?, ?)`)
        .bind(receiptId, `receipt:${key}`, messageId, agentId, JSON.stringify({ stored: true, status: "pending", direction: "to_max" }), fingerprint, stamp),
    ]);
  } catch (error) {
    const raced = await env.DB.prepare("SELECT * FROM agent_messages WHERE idempotency_key = ?").bind(key).first<AgentMessageRow>();
    if (!raced) throw error;
    assertIdempotentPayload(raced.payload_fingerprint, fingerprint);
    return { created: false, message: raced, receipt: await agentReceiptByKey(env, `receipt:${key}`) };
  }
  const message = await env.DB.prepare("SELECT * FROM agent_messages WHERE message_id = ?").bind(messageId).first<AgentMessageRow>();
  return { created: true, message, receipt: await agentReceiptByKey(env, `receipt:${key}`) };
}

async function agentInbox(url: URL, env: Env, credential: AgentCredential) {
  const agentId = cleanString(url.searchParams.get("agent_id"), "agent_id", 120);
  const runId = url.searchParams.get("run_id")?.trim() || null;
  if (runId && runId.length > 200) throw new Error("Invalid run_id");
  const scopedTaskId = url.searchParams.get("task_id")?.trim() || null;
  const scopedRecordId = url.searchParams.get("record_id")?.trim() || null;
  if (credential.mode === "task" && (!scopedTaskId || !scopedRecordId)) throw new Error("Scoped inbox requires task_id and record_id");
  if (scopedTaskId && scopedTaskId.length > 200) throw new Error("Invalid task_id");
  if (scopedRecordId && scopedRecordId.length > 200) throw new Error("Invalid record_id");
  assertAgentScope(credential, { agentId, taskId: scopedTaskId ?? undefined, recordId: scopedRecordId ?? undefined });
  const result = await env.DB.prepare(`SELECT * FROM agent_messages
    WHERE direction = 'to_agent' AND agent_id = ? AND status IN ('pending', 'delivered')
      AND (? IS NULL OR run_id IS NULL OR run_id = ?)
      AND (? IS NULL OR task_id = ?)
      AND (? IS NULL OR record_id = ?)
    ORDER BY created_at ASC LIMIT 50`).bind(agentId, runId, runId, scopedTaskId, scopedTaskId, scopedRecordId, scopedRecordId).all<AgentMessageRow>();
  return result.results.map(messageJson);
}

async function recordMessageReceipt(request: Request, env: Env, messageId: string, credential: AgentCredential) {
  const payload = await boundedJson(request);
  const key = requestIdempotencyKey(request, "agent-message-receipt");
  const agentId = cleanString(payload.agent_id, "agent_id", 120);
  const kind = cleanString(payload.kind, "kind", 40);
  if (!new Set(["delivered", "acknowledged"]).has(kind)) throw new Error("Unsupported receipt kind");
  const message = await env.DB.prepare("SELECT * FROM agent_messages WHERE message_id = ?").bind(messageId).first<AgentMessageRow>();
  if (!message || message.direction !== "to_agent") throw new Error("Message not found");
  if (message.agent_id !== agentId) throw new Error("Message belongs to another agent");
  if (!message.record_id) throw new Error("Message has no record scope");
  assertAgentScope(credential, { agentId, taskId: message.task_id, recordId: message.record_id });
  const fingerprint = await payloadFingerprint("agent-message-receipt", [messageId, agentId, kind]);

  const duplicate = await agentReceiptByKey(env, `receipt:${key}`);
  if (duplicate) {
    assertIdempotentPayload(duplicate.payload_fingerprint, fingerprint);
    return { created: false, message, receipt: duplicate };
  }

  const before = { status: message.status, delivered_at: message.delivered_at, acknowledged_at: message.acknowledged_at };
  const stamp = now();
  const after = kind === "acknowledged"
    ? { status: "acknowledged", delivered_at: message.delivered_at ?? stamp, acknowledged_at: stamp }
    : message.status === "acknowledged"
      ? before
      : { status: "delivered", delivered_at: message.delivered_at ?? stamp, acknowledged_at: null };
  const receiptId = id("arct");
  try {
    await env.DB.batch([
      kind === "acknowledged"
        ? env.DB.prepare("UPDATE agent_messages SET status = 'acknowledged', delivered_at = COALESCE(delivered_at, ?), acknowledged_at = COALESCE(acknowledged_at, ?) WHERE message_id = ? AND agent_id = ?")
          .bind(stamp, stamp, messageId, agentId)
        : env.DB.prepare("UPDATE agent_messages SET status = CASE WHEN status = 'acknowledged' THEN status ELSE 'delivered' END, delivered_at = COALESCE(delivered_at, ?) WHERE message_id = ? AND agent_id = ?")
          .bind(stamp, messageId, agentId),
      env.DB.prepare(`INSERT INTO agent_receipts
        (receipt_id, idempotency_key, subject_type, subject_id, agent_id, kind, before_json, after_json, payload_fingerprint, created_at)
        VALUES (?, ?, 'message', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(receiptId, `receipt:${key}`, messageId, agentId, kind, JSON.stringify(before), JSON.stringify(after), fingerprint, stamp),
    ]);
  } catch (error) {
    const raced = await agentReceiptByKey(env, `receipt:${key}`);
    if (!raced) throw error;
    assertIdempotentPayload(raced.payload_fingerprint, fingerprint);
    const racedMessage = await env.DB.prepare("SELECT * FROM agent_messages WHERE message_id = ?").bind(messageId).first<AgentMessageRow>();
    return { created: false, message: racedMessage, receipt: raced };
  }
  const updated = await env.DB.prepare("SELECT * FROM agent_messages WHERE message_id = ?").bind(messageId).first<AgentMessageRow>();
  return { created: true, message: updated, receipt: await agentReceiptByKey(env, `receipt:${key}`) };
}

async function appendInstructionAudit(env: Env, record: FeishuRecord, message: AgentMessageRow) {
  if (!usesWarBoard(env)) throw new Error("Agent instructions require the war-board schema");
  const marker = message.note_marker;
  if (!marker) throw new Error("Instruction has no audit marker");
  const existingNote = fieldText(record.fields["备注"]);
  if (existingNote.includes(marker)) return false;
  const timestamp = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai",
  }).format(new Date()).replaceAll("/", "-");
  const cleanBody = message.body.replaceAll("\n", " ");
  const label = message.kind === "answer" ? "回复" : "指示";
  const line = `[${timestamp}｜OPS] ${label}→${message.agent_id}：“${cleanBody}”；task:${message.task_id}；${marker}`;
  await feishu(`${recordBase(env)}/${encodeURIComponent(record.record_id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${await baseToken(env)}` },
    body: JSON.stringify({ fields: { "备注": [existingNote.trim(), line].filter(Boolean).join("\n") } }),
  });
  return true;
}

async function finalizeMaxInstruction(env: Env, message: AgentMessageRow, originalRecord?: FeishuRecord) {
  const current = originalRecord ?? await assertTaskReference(env, message.task_id, message.record_id ?? message.task_id);
  await appendInstructionAudit(env, current, message);
  const receiptKey = `receipt:${message.idempotency_key}`;
  let receipt = await agentReceiptByKey(env, receiptKey);
  if (!receipt) {
    const receiptId = id("arct");
    const stamp = now();
    const statements = [
      env.DB.prepare("UPDATE agent_messages SET status = 'pending' WHERE message_id = ? AND status = 'preparing'").bind(message.message_id),
      env.DB.prepare(`INSERT OR IGNORE INTO agent_receipts
        (receipt_id, idempotency_key, subject_type, subject_id, agent_id, kind, before_json, after_json, payload_fingerprint, created_at)
        VALUES (?, ?, 'message', ?, ?, 'queued', ?, ?, ?, ?)`)
        .bind(receiptId, receiptKey, message.message_id, message.agent_id,
          JSON.stringify({ delivery_status: null, feishu_note_marker: false }),
          JSON.stringify({ delivery_status: "pending", feishu_note_marker: message.note_marker }), message.payload_fingerprint, stamp),
    ];
    if (message.in_reply_to) {
      statements.push(env.DB.prepare("UPDATE agent_messages SET status = 'answered' WHERE message_id = ? AND direction = 'to_max' AND status = 'pending'").bind(message.in_reply_to));
    }
    await env.DB.batch(statements);
    receipt = await agentReceiptByKey(env, receiptKey);
  }
  const updated = await env.DB.prepare("SELECT * FROM agent_messages WHERE message_id = ?").bind(message.message_id).first<AgentMessageRow>();
  if (!updated || !receipt) throw new Error("Instruction finalization was not visible");
  return { message: updated, receipt };
}

async function createMaxInstruction(request: Request, env: Env, actor: Actor) {
  const payload = await boundedJson(request);
  const key = requestIdempotencyKey(request, "max-instruction");
  const taskId = cleanString(payload.task_id, "task_id", 200);
  const recordId = cleanString(payload.record_id, "record_id", 200);
  const agentId = cleanString(payload.agent_id, "agent_id", 120);
  const runId = payload.run_id === undefined || payload.run_id === null || payload.run_id === "" ? null : cleanString(payload.run_id, "run_id", 200);
  const body = cleanString(payload.body, "body", 2000);
  const inReplyTo = payload.in_reply_to === undefined || payload.in_reply_to === null || payload.in_reply_to === "" ? null : cleanString(payload.in_reply_to, "in_reply_to", 200);
  const fingerprint = await payloadFingerprint("max-instruction", [taskId, recordId, agentId, runId, body, inReplyTo]);
  const record = await assertTaskReference(env, taskId, recordId);
  if (inReplyTo) {
    const question = await env.DB.prepare("SELECT * FROM agent_messages WHERE message_id = ?").bind(inReplyTo).first<AgentMessageRow>();
    if (!question || question.direction !== "to_max" || question.kind !== "question" || question.task_id !== taskId || question.agent_id !== agentId) {
      throw new Error("Reply target does not match this task and agent");
    }
  }

  const existing = await env.DB.prepare("SELECT * FROM agent_messages WHERE idempotency_key = ?").bind(key).first<AgentMessageRow>();
  if (existing) {
    assertIdempotentPayload(existing.payload_fingerprint, fingerprint);
    if (existing.status === "preparing") return { created: false, ...await finalizeMaxInstruction(env, existing, record) };
    return { created: false, message: existing, receipt: await agentReceiptByKey(env, `receipt:${key}`) };
  }

  const messageId = id("amsg");
  const noteMarker = `receipt marker MAXOPS-MSG:${messageId}`;
  const stamp = now();
  try {
    await env.DB.prepare(`INSERT INTO agent_messages
      (message_id, idempotency_key, task_id, record_id, run_id, agent_id, direction, kind, body, in_reply_to, status, created_by, note_marker, payload_fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'to_agent', ?, ?, ?, 'preparing', ?, ?, ?, ?)`)
      .bind(messageId, key, taskId, recordId, runId, agentId, inReplyTo ? "answer" : "instruction", body, inReplyTo, actor.name, noteMarker, fingerprint, stamp).run();
  } catch (error) {
    const raced = await env.DB.prepare("SELECT * FROM agent_messages WHERE idempotency_key = ?").bind(key).first<AgentMessageRow>();
    if (!raced) throw error;
    assertIdempotentPayload(raced.payload_fingerprint, fingerprint);
    return { created: false, ...await finalizeMaxInstruction(env, raced, record) };
  }
  const message = await env.DB.prepare("SELECT * FROM agent_messages WHERE message_id = ?").bind(messageId).first<AgentMessageRow>();
  if (!message) throw new Error("Instruction insert was not visible");
  return { created: true, ...await finalizeMaxInstruction(env, message, record) };
}

function taskCandidates(records: FeishuRecord[]): TaskCandidate[] {
  return records.map((record) => {
    const stage = stageFromFields(record.fields);
    const projectName = fieldText(record.fields["项目"], "未归档");
    return {
      recordId: record.record_id,
      id: taskIdForRecord(record),
      title: fieldText(record.fields["任务"], "未命名任务"),
      projectId: fieldText(record.fields.project_id, projectName),
      projectName,
      done: stage === "done",
      stage,
    };
  });
}

async function hydrateEntities(env: Env, tasks: TaskCandidate[], observedVersions: Map<string, number>) {
  if (!tasks.length) return;
  const stamp = now();
  await env.DB.batch(tasks.map((task) => env.DB.prepare(
    `INSERT INTO task_entities (task_id, record_id, state, stage, version, causation_id, updated_at)
      VALUES (?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        record_id = excluded.record_id,
        state = CASE WHEN task_entities.stage != excluded.stage THEN excluded.state ELSE task_entities.state END,
        stage = CASE WHEN task_entities.stage != excluded.stage THEN excluded.stage ELSE task_entities.stage END,
        version = CASE WHEN task_entities.stage != excluded.stage THEN task_entities.version + 1 ELSE task_entities.version END,
        causation_id = CASE WHEN task_entities.stage != excluded.stage THEN 'feishu:manual-sync' ELSE task_entities.causation_id END,
        updated_at = CASE WHEN task_entities.stage != excluded.stage THEN excluded.updated_at ELSE task_entities.updated_at END
      WHERE task_entities.version = ?`,
  ).bind(task.id, task.recordId, task.done ? 1 : 0, task.stage, stamp, observedVersions.get(task.id) ?? -1)));
}

async function entityVersions(env: Env) {
  const rows = await env.DB.prepare("SELECT task_id, version FROM task_entities").all<Pick<EntityRow, "task_id" | "version">>();
  return new Map(rows.results.map((row) => [row.task_id, row.version]));
}

async function entity(env: Env, taskId: string) {
  return env.DB.prepare("SELECT * FROM task_entities WHERE task_id = ?").bind(taskId).first<EntityRow>();
}

async function command(env: Env, commandId: string) {
  return env.DB.prepare("SELECT * FROM commands WHERE command_id = ?").bind(commandId).first<CommandRow>();
}

async function receiptForCommand(env: Env, commandId: string) {
  return env.DB.prepare("SELECT * FROM receipts WHERE command_id = ?").bind(commandId).first<ReceiptRow>();
}

async function appendEvent(env: Env, commandId: string, runId: string, kind: string, detail: Record<string, unknown>, eventId = id("evt")) {
  return env.DB.prepare("INSERT OR IGNORE INTO events (event_id, command_id, run_id, kind, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(eventId, commandId, runId, kind, JSON.stringify(detail), now()).run();
}

async function createCommand(env: Env, input: {
  commandId?: string;
  idempotencyKey: string;
  source: "feishu" | "h5";
  sourceEventId?: string;
  actorHash: string;
  actorName?: string;
  rawInput: string;
  status: string;
  intent?: string;
  taskId?: string;
  recordId?: string;
  targetState?: TaskStage;
  confidence?: number;
  reason?: string;
  expectedVersion?: number;
  modelProvider?: string;
  modelName?: string;
  modelResponseId?: string;
  approvedGate?: { beforeJson: string; afterJson: string; decidedByHash: string };
  recoveryNotification?: { kind: string; openId: string; text: string };
}) {
  const existing = await env.DB.prepare("SELECT * FROM commands WHERE idempotency_key = ? OR (? IS NOT NULL AND source_event_id = ?)")
    .bind(input.idempotencyKey, input.sourceEventId ?? null, input.sourceEventId ?? null).first<CommandRow>();
  if (existing) {
    if (existing.actor_hash !== input.actorHash || existing.source !== input.source) throw new Error("Idempotency key belongs to a different actor or source");
    return { row: existing, created: false };
  }
  const commandId = input.commandId ?? id("cmd");
  const runId = id("run");
  const stamp = now();
  const identity = { command_id: commandId, run_id: runId };
  const recoveryValues = input.recoveryNotification
    ? await notificationValues(env, identity, input.recoveryNotification.kind, input.recoveryNotification.openId, input.recoveryNotification.text.replace("{run_id}", runId))
    : null;
  try {
    const statements = [
      env.DB.prepare(`INSERT INTO commands (
        command_id, idempotency_key, source, source_event_id, actor_hash, actor_name, raw_input,
        intent, task_id, record_id, target_state, confidence, reason, status, expected_version,
        claimed_version, run_id, receipt_id, model_provider, model_name, model_response_id, attempts, error,
        created_at, updated_at, confirmed_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, 0, NULL, ?, ?, ?, NULL)`)
        .bind(commandId, input.idempotencyKey, input.source, input.sourceEventId ?? null, input.actorHash, input.actorName ?? null, input.rawInput,
          input.intent ?? null, input.taskId ?? null, input.recordId ?? null, input.targetState ?? null, input.confidence ?? null, input.reason ?? null,
          input.status, input.expectedVersion ?? null, runId, input.modelProvider ?? null, input.modelName ?? null, input.modelResponseId ?? null,
          stamp, stamp, input.status === "confirmed" ? stamp : null),
      env.DB.prepare("INSERT INTO runs (run_id, command_id, status, provider, model, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
        .bind(runId, commandId, input.status, input.modelProvider ?? null, input.modelName ?? null, stamp),
    ];
    if (input.approvedGate) {
      statements.push(env.DB.prepare(`INSERT INTO gates (gate_id, command_id, status, before_json, after_json, requested_at, decided_at, decided_by_hash)
        VALUES (?, ?, 'approved', ?, ?, ?, ?, ?)`)
        .bind(id("gate"), commandId, input.approvedGate.beforeJson, input.approvedGate.afterJson, stamp, stamp, input.approvedGate.decidedByHash));
    }
    if (input.recoveryNotification && recoveryValues) {
      statements.push(notificationInsert(env, identity, input.recoveryNotification.kind, recoveryValues, stamp, input.status));
    }
    await env.DB.batch(statements);
  } catch (error) {
    const raced = await env.DB.prepare("SELECT * FROM commands WHERE idempotency_key = ? OR (? IS NOT NULL AND source_event_id = ?)")
      .bind(input.idempotencyKey, input.sourceEventId ?? null, input.sourceEventId ?? null).first<CommandRow>();
    if (raced) {
      if (raced.actor_hash !== input.actorHash || raced.source !== input.source) throw new Error("Idempotency key belongs to a different actor or source");
      return { row: raced, created: false };
    }
    throw error;
  }
  const row = await command(env, commandId);
  if (!row) throw new Error("Command insert was not visible");
  return { row, created: true };
}

async function callIntentModel(env: Env, input: string, tasks: TaskCandidate[], safetyIdentifier: string) {
  const proxyConfigured = Boolean(env.MAXOPS_MODEL_PROXY_URL && env.MAXOPS_MODEL_PROXY_TOKEN);
  const requestedModel = proxyConfigured ? "@cf/openai/gpt-oss-20b" : (env.OPENAI_MODEL || "gpt-5-mini");
  const response = await fetch(proxyConfigured ? required(env, "MAXOPS_MODEL_PROXY_URL") : "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${required(env, proxyConfigured ? "MAXOPS_MODEL_PROXY_TOKEN" : "OPENAI_API_KEY")}`,
    },
    body: JSON.stringify({
      model: requestedModel,
      store: false,
      // gpt-oss can spend part of the budget on reasoning before emitting the
      // schema-constrained final answer. Leave enough room for both phases.
      max_output_tokens: 800,
      reasoning: { effort: "low" },
      safety_identifier: safetyIdentifier.slice(0, 64),
      instructions: "你是 OPS 的任务路由器。只根据用户话语的语义和候选任务判断是否要把一个任务改为待办、进行中、等外部、完成或放弃。不得依赖固定关键词；不得编造候选之外的 entity。歧义时 intent=unknown。reason 用一句简短中文说明。",
      input: `用户原话：${input}\n\n候选任务：\n${JSON.stringify(tasks.map((task) => ({ id: task.id, title: task.title, project: task.projectName, stage: task.stage })))}`,
      text: { format: { type: "json_schema", name: "max_ops_intent", strict: true, schema: decisionSchema } },
    }),
  });
  if (!response.ok) throw new Error(`Intent model failed (${response.status})`);
  const body = await response.json() as { id?: string; model?: string; output_text?: string; output?: unknown[] };
  const text = outputText(body);
  const decision = text
    ? normalizeDecision(JSON.parse(text), tasks)
    : normalizeDecision({
      intent: "unknown",
      entity: "",
      target_state: "none",
      confidence: 0,
      reason: "没有收到可验证的结构化结果，请明确任务名称和目标状态",
    }, tasks);
  return {
    decision,
    responseId: body.id ?? "",
    model: body.model ?? requestedModel,
    provider: proxyConfigured ? "cloudflare_workers_ai" : "openai_responses",
  };
}

function projectionSource(row: Pick<CommandRow, "run_id" | "receipt_id">) {
  if (!row.receipt_id) throw new Error("Projection has no stable receipt ID");
  return `OPS · ${row.run_id} · ${row.receipt_id}`;
}

async function reconcileProjection(env: Env, taskId: string, recordId: string, claimedVersion: number) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const authoritative = await entity(env, taskId);
    if (!authoritative || authoritative.version === claimedVersion) return;
    const cause = authoritative.causation_id ? await command(env, authoritative.causation_id) : null;
    const source = cause?.receipt_id ? projectionSource(cause) : `OPS · ledger v${authoritative.version}`;
    const remote = await getBaseRecord(env, recordId);
    const remoteMatches = usesWarBoard(env)
      ? stageFromFields(remote.fields) === authoritative.stage && projectionMarker(env, remote, source)
      : Boolean(remote.fields["完成"]) === Boolean(authoritative.state) && projectionMarker(env, remote, source);
    if (!remoteMatches) {
      await writeBaseRecord(env, recordId, authoritative.stage, source, { rawInput: cause?.raw_input, reason: cause?.reason ?? "根据持久台账恢复已确认状态" });
    }
    const stable = await entity(env, taskId);
    if (stable?.version === authoritative.version) return;
  }
  throw new Error("Projection changed during three reconciliation attempts");
}

async function finishFailure(env: Env, row: CommandRow, message: string, openId?: string) {
  const stamp = now();
  const receiptId = row.receipt_id ?? id("rct");
  const taskId = row.task_id ?? "unresolved";
  const version = row.claimed_version ?? row.expected_version ?? -1;
  const failureText = `❌ OPS 写回失败\nrun: ${row.run_id}\nreceipt: ${receiptId}\n原因：${redactError(message)}`;
  const statements = [
    env.DB.prepare(`UPDATE commands SET status = 'failed', receipt_id = COALESCE(receipt_id, ?), processing_token = NULL,
      processing_lease_until = NULL, processing_stage = NULL, projection_token = NULL, projection_lease_until = NULL, error = ?, updated_at = ?, completed_at = ?
      WHERE command_id = ? AND status NOT IN ('succeeded', 'failed', 'superseded_unknown', 'cancelled', 'projection_inflight')`)
      .bind(receiptId, redactError(message), stamp, stamp, row.command_id),
    env.DB.prepare("UPDATE runs SET status = 'failed', completed_at = ? WHERE run_id = ? AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'failed')")
      .bind(stamp, row.run_id, row.command_id),
    env.DB.prepare(`INSERT INTO receipts (receipt_id, command_id, run_id, status, task_id, entity_version, before_json, after_json, notification_status, created_at)
      SELECT ?, ?, ?, 'failed', ?, ?, '{}', '{}', ?, ?
      WHERE EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'failed')
      ON CONFLICT(command_id) DO UPDATE SET status = 'failed', notification_status = excluded.notification_status`)
      .bind(receiptId, row.command_id, row.run_id, taskId, version, openId ? "pending" : "not_requested", stamp, row.command_id),
  ];
  let notificationId: string | null = null;
  if (openId) {
    const values = await notificationValues(env, row, "terminal_failure", openId, failureText);
    notificationId = values.notificationId;
    statements.push(notificationInsert(env, row, "terminal_failure", values, stamp, "failed"));
  }
  const results = await env.DB.batch(statements);
  if ((results[0].meta.changes ?? 0) !== 1) return receiptForCommand(env, row.command_id);
  const durableReceipt = await receiptForCommand(env, row.command_id);
  const durableReceiptId = durableReceipt?.receipt_id ?? receiptId;
  try {
    await appendEvent(env, row.command_id, row.run_id, "failed", { message: redactError(message), receiptId: durableReceiptId });
  } catch (error) {
    console.error(JSON.stringify({ event: "failure_event_failed", commandId: row.command_id, message: redactError(error) }));
  }
  if (notificationId) await flushNotification(env, notificationId);
}

async function finishUnknown(env: Env, row: CommandRow, ownerToken: string, message: string, current: EntityRow | null, openId?: string) {
  const stamp = now();
  const receipt = await receiptForCommand(env, row.command_id);
  const receiptId = receipt?.receipt_id ?? row.receipt_id ?? id("rct");
  const text = `⚠️ OPS 历史投影无法确认\nrun: ${row.run_id}\nreceipt: ${receiptId}\n原因：${redactError(message)}${current ? `\n当前状态：${stageDisplay(current.stage)} (v${current.version})` : ""}`;
  const statements = [
    env.DB.prepare(`UPDATE commands SET status = 'superseded_unknown', receipt_id = COALESCE(receipt_id, ?), projection_token = NULL, projection_lease_until = NULL,
      error = ?, updated_at = ?, completed_at = ?
      WHERE command_id = ? AND status = 'projection_inflight' AND projection_token = ?`)
      .bind(receiptId, redactError(message), stamp, stamp, row.command_id, ownerToken),
    env.DB.prepare(`UPDATE runs SET status = 'superseded_unknown', completed_at = ? WHERE run_id = ?
      AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'superseded_unknown')`)
      .bind(stamp, row.run_id, row.command_id),
    env.DB.prepare(`UPDATE receipts SET status = 'superseded_unknown', notification_status = ? WHERE command_id = ?
      AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'superseded_unknown')`)
      .bind(openId ? "pending" : "not_requested", row.command_id, row.command_id),
  ];
  let notificationId: string | null = null;
  if (openId) {
    const values = await notificationValues(env, row, "terminal_unknown", openId, text);
    notificationId = values.notificationId;
    statements.push(notificationInsert(env, row, "terminal_unknown", values, stamp, "superseded_unknown"));
  }
  const results = await env.DB.batch(statements);
  if ((results[0].meta.changes ?? 0) !== 1) return receiptForCommand(env, row.command_id);
  try { await appendEvent(env, row.command_id, row.run_id, "projection_unknown", { message: redactError(message), receiptId }); } catch { /* Display event is best-effort. */ }
  if (notificationId) await flushNotification(env, notificationId);
  return receiptForCommand(env, row.command_id);
}

async function renderSuccessNotification(env: Env, row: CommandRow, receipt: ReceiptRow) {
  let before: { done?: boolean; stage?: TaskStage } = {};
  let after: { done?: boolean; stage?: TaskStage } = {};
  try { before = JSON.parse(receipt.before_json) as { done?: boolean; stage?: TaskStage }; } catch { /* Durable receipt is still valid without display detail. */ }
  try { after = JSON.parse(receipt.after_json) as { done?: boolean; stage?: TaskStage }; } catch { /* Durable receipt is still valid without display detail. */ }
  let current: EntityRow | null = null;
  try { current = row.task_id ? await entity(env, row.task_id) : null; } catch { /* Current-state context is display-only. */ }
  const superseded = Boolean(current && current.version > receipt.entity_version);
  const currentStatus = usesWarBoard(env) ? stageDisplay(current?.stage ?? (current?.state ? "done" : "open")) : current?.state ? "完成" : "未完成";
  const currentLine = superseded ? `\n这是历史写回；当前状态：${currentStatus} (v${current?.version})` : "";
  const beforeStage = before.stage ?? (before.done ? "done" : "open");
  const afterStage = after.stage ?? (after.done ? "done" : "open");
  const transition = usesWarBoard(env)
    ? `${stageDisplay(beforeStage)} → ${stageDisplay(afterStage)}`
    : `${before.done ? "完成" : "未完成"} → ${after.done ? "完成" : "重新打开"}`;
  return `✅ OPS ${superseded ? "历史写回已确认，随后被更新" : "已写回"}\n任务：${row.raw_input}\n${transition}\nrun: ${row.run_id}\nreceipt: ${receipt.receipt_id}\nversion: ${receipt.entity_version}${currentLine}`;
}

async function successNotificationText(env: Env, commandId: string, fallback: string) {
  const [row, receipt] = await Promise.all([command(env, commandId), receiptForCommand(env, commandId)]);
  return row && receipt ? renderSuccessNotification(env, row, receipt) : fallback;
}

async function deliverSuccessNotification(env: Env, row: CommandRow, receipt: ReceiptRow, openId?: string) {
  if (!openId || receipt.notification_status === "sent") return receipt;
  const text = await renderSuccessNotification(env, row, receipt);
  receipt.notification_status = await notifyDurably(env, row, "terminal_success", openId, text) ? "sent" : "failed";
  return receipt;
}

async function markProjectionApplied(env: Env, row: CommandRow, ownerToken: string) {
  if (row.projection_applied_at) return row;
  const stamp = now();
  const marked = await env.DB.prepare(`UPDATE commands SET projection_applied_at = COALESCE(projection_applied_at, ?), updated_at = ?
    WHERE command_id = ? AND status = 'projection_inflight' AND projection_token = ?`)
    .bind(stamp, stamp, row.command_id, ownerToken).run();
  if ((marked.meta.changes ?? 0) !== 1) throw new Error("Projection owner was fenced before applied evidence");
  row.projection_applied_at = stamp;
  return row;
}

async function prepareProjection(env: Env, row: CommandRow, notifyOpenId?: string) {
  if (!row.task_id || !row.record_id || !row.target_state || row.expected_version === null) throw new Error("Command is missing a resolved target");
  if (row.status === "confirmed") {
    let before = await entity(env, row.task_id);
    if (!before) throw new Error("Task entity is missing");
    if (before.causation_id && before.causation_id !== row.command_id) {
      const previous = await command(env, before.causation_id);
      if (previous && ["projection_prepared", "projection_inflight"].includes(previous.status)) {
        try {
          await executeCommand(env, previous.command_id, undefined, 1);
        } catch (error) {
          throw new RecoverableProjectionError(`Prior entity projection is not terminal: ${redactError(error)}`);
        }
        before = await entity(env, row.task_id);
        if (!before) throw new Error("Task entity disappeared after predecessor recovery");
      }
    }
    if (before.version !== row.expected_version) {
      await finishFailure(env, row, "状态已被更新；这条旧命令没有覆盖新版本", notifyOpenId);
      throw new Error("Stale entity version");
    }
    // Feishu is the human-edit source of truth. Once any pending predecessor
    // is terminal, re-read Base immediately before claiming the next D1
    // version so a later user edit invalidates this command instead of being
    // silently overwritten.
    const observedVersions = new Map([[row.task_id, before.version]]);
    const remote = await getBaseRecord(env, row.record_id);
    if (taskIdForRecord(remote) !== row.task_id) throw new Error("Task identity mismatch before projection");
    await hydrateEntities(env, taskCandidates([remote]), observedVersions);
    before = await entity(env, row.task_id);
    if (!before) throw new Error("Task entity disappeared after Feishu preflight");
    if (before.version !== row.expected_version) {
      await finishFailure(env, row, "状态已被更新；这条旧命令没有覆盖新版本", notifyOpenId);
      throw new Error("Stale entity version");
    }
    const receiptId = id("rct");
    const claimedVersion = row.expected_version + 1;
    const targetStage = normalizedTargetStage(row.target_state);
    const target = targetStage === "done" ? 1 : 0;
    const stamp = now();
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE commands SET status = 'projection_prepared', receipt_id = ?, claimed_version = ?, updated_at = ?
          WHERE command_id = ? AND status = 'confirmed'`).bind(receiptId, claimedVersion, stamp, row.command_id),
        env.DB.prepare(`INSERT INTO receipts (receipt_id, command_id, run_id, status, task_id, entity_version, before_json, after_json, notification_status, created_at)
          VALUES (?, ?, ?, 'projection_pending', ?, ?, ?, ?, ?, ?)`)
          .bind(receiptId, row.command_id, row.run_id, row.task_id, claimedVersion,
            JSON.stringify({ done: Boolean(before.state), stage: before.stage, version: before.version }), JSON.stringify({ done: Boolean(target), stage: targetStage, version: claimedVersion }),
            notifyOpenId ? "pending" : "not_requested", stamp),
        env.DB.prepare("UPDATE runs SET status = 'projection_prepared' WHERE run_id = ?").bind(row.run_id),
      ]);
      if ((results[0].meta.changes ?? 0) !== 1) throw new Error("Projection preparation lost a race");
    } catch (error) {
      const raced = await command(env, row.command_id);
      if (!raced || !["projection_prepared", "projection_inflight", "succeeded"].includes(raced.status)) throw error;
    }
    row = await command(env, row.command_id) ?? row;
  }

  if (!["projection_prepared", "projection_inflight", "succeeded"].includes(row.status)) throw new Error(`Command cannot execute from ${row.status}`);
  if (!row.task_id || !row.record_id || !row.target_state || row.expected_version === null) throw new Error("Prepared projection lost its target");
  const taskId = row.task_id;
  const receipt = await receiptForCommand(env, row.command_id);
  if (!receipt || !row.receipt_id || row.claimed_version === null) throw new Error("Prepared projection is missing its durable receipt");
  if (row.status === "succeeded" || receipt.status === "succeeded") return { row, receipt, acquired: false, ownerToken: null as string | null };

  const targetStage = normalizedTargetStage(row.target_state);
  const target = targetStage === "done" ? 1 : 0;
  const current = await entity(env, taskId);
  if (!current) throw new Error("Task entity is missing");
  if (current.version > row.claimed_version) return { row, receipt, acquired: false, ownerToken: null as string | null };
  if (!(current.version === row.claimed_version && current.causation_id === row.command_id)) {
    if (current.version !== row.expected_version) {
      await finishFailure(env, row, "状态已被更新；这条旧命令没有覆盖新版本", notifyOpenId);
      throw new Error("Stale entity version");
    }
    const claim = await env.DB.prepare(`UPDATE task_entities SET state = ?, stage = ?, version = ?, causation_id = ?, updated_at = ?
      WHERE task_id = ? AND version = ?`).bind(target, targetStage, row.claimed_version, row.command_id, now(), taskId, row.expected_version).run();
    if ((claim.meta.changes ?? 0) !== 1) {
      const raced = await entity(env, taskId);
      if (!(raced?.version === row.claimed_version && raced.causation_id === row.command_id)) {
        await finishFailure(env, row, "状态已被更新；这条旧命令没有覆盖新版本", notifyOpenId);
        throw new Error("Stale entity version");
      }
    }
  }

  let acquired = false;
  let ownerToken: string | null = null;
  if (row.status === "projection_prepared") {
    const stamp = now();
    ownerToken = id("projection");
    const acquiredBatch = await env.DB.batch([
      env.DB.prepare(`UPDATE commands SET status = 'projection_inflight', projection_token = ?, projection_lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE command_id = ? AND status = 'projection_prepared'`).bind(ownerToken, stamp + projectionLeaseMs(env), stamp, row.command_id),
      env.DB.prepare(`UPDATE runs SET status = 'projection_inflight' WHERE run_id = ?
        AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'projection_inflight' AND projection_token = ?)`)
        .bind(row.run_id, row.command_id, ownerToken),
      env.DB.prepare(`INSERT OR IGNORE INTO events (event_id, command_id, run_id, kind, detail_json, created_at)
        SELECT ?, ?, ?, 'write_started', ?, ?
        WHERE EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'projection_inflight' AND projection_token = ?)`)
        .bind(id("evt"), row.command_id, row.run_id, JSON.stringify({ taskId: row.task_id, receiptId: row.receipt_id, version: row.claimed_version }), stamp, row.command_id, ownerToken),
    ]);
    acquired = (acquiredBatch[0].meta.changes ?? 0) === 1;
    row = await command(env, row.command_id) ?? row;
    if (!acquired) ownerToken = null;
  }
  return { row, receipt, acquired, ownerToken };
}

async function finalizeProjection(env: Env, row: CommandRow, receipt: ReceiptRow, notifyOpenId?: string, ownerToken?: string | null) {
  if (receipt.status !== "succeeded") {
    if (!ownerToken) throw new Error("Projection finalization requires an owner token");
    const completed = now();
    const successValues = notifyOpenId
      ? await notificationValues(env, row, "terminal_success", notifyOpenId, await renderSuccessNotification(env, row, receipt))
      : null;
    const finalizedStatements = [
      env.DB.prepare(`UPDATE receipts SET status = 'succeeded' WHERE command_id = ? AND status = 'projection_pending'
        AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'projection_inflight' AND projection_token = ?)`)
        .bind(row.command_id, row.command_id, ownerToken),
      env.DB.prepare(`UPDATE commands SET status = 'succeeded', projection_token = NULL, projection_lease_until = NULL, error = NULL, updated_at = ?, completed_at = ?
        WHERE command_id = ? AND status = 'projection_inflight' AND projection_token = ?`)
        .bind(completed, completed, row.command_id, ownerToken),
      env.DB.prepare("UPDATE runs SET status = 'succeeded', completed_at = ? WHERE run_id = ? AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'succeeded')")
        .bind(completed, row.run_id, row.command_id),
    ];
    if (successValues) finalizedStatements.push(notificationInsert(env, row, "terminal_success", successValues, completed, "succeeded"));
    const finalized = await env.DB.batch(finalizedStatements);
    if ((finalized[1].meta.changes ?? 0) !== 1) {
      const durable = await receiptForCommand(env, row.command_id);
      if (durable?.status === "succeeded") return deliverSuccessNotification(env, await command(env, row.command_id) ?? row, durable, notifyOpenId);
      throw new Error("Projection owner was fenced before finalization");
    }
    receipt.status = "succeeded";
    try {
      await appendEvent(env, row.command_id, row.run_id, "write_succeeded", { receiptId: receipt.receipt_id, taskId: row.task_id, version: receipt.entity_version });
    } catch (error) {
      console.error(JSON.stringify({ event: "write_success_event_failed", commandId: row.command_id, message: redactError(error) }));
    }
  }
  return deliverSuccessNotification(env, row, receipt, notifyOpenId);
}

async function claimProjectionRecovery(env: Env, row: CommandRow, requireExpired: boolean) {
  const token = id("projection");
  const stamp = now();
  const expiryGuard = requireExpired ? "AND COALESCE(projection_lease_until, 0) <= ?" : "AND ? = ?";
  const claimed = await env.DB.prepare(`UPDATE commands SET projection_token = ?, projection_lease_until = ?, attempts = attempts + 1, updated_at = ?
    WHERE command_id = ? AND status = 'projection_inflight' AND COALESCE(projection_token, '') = COALESCE(?, '') ${expiryGuard}`)
    .bind(token, stamp + projectionLeaseMs(env), stamp, row.command_id, row.projection_token, ...(requireExpired ? [stamp] : [1, 1])).run();
  return (claimed.meta.changes ?? 0) === 1 ? token : null;
}

async function executeProjectionPass(env: Env, commandId: string, notifyOpenId?: string, recoverUnmarked = false) {
  let row = await command(env, commandId);
  if (!row) throw new Error("Command not found");
  const existing = await receiptForCommand(env, commandId);
  if (row.status === "succeeded" && existing?.status === "succeeded") return deliverSuccessNotification(env, row, existing, notifyOpenId);
  const prepared = await prepareProjection(env, row, notifyOpenId);
  row = prepared.row;
  if (row.status === "succeeded" || prepared.receipt.status === "succeeded") return finalizeProjection(env, row, prepared.receipt, notifyOpenId);
  if (!row.record_id || !row.task_id || row.claimed_version === null) throw new Error("Projection target disappeared");
  const recordId = row.record_id;
  const taskId = row.task_id;
  const targetState = row.target_state;
  if (!targetState) throw new Error("Projection target state disappeared");
  const claimedVersion = row.claimed_version;
  let ownerToken = prepared.ownerToken;
  let recoveredExpiredOwner = false;
  let stopHeartbeat = ownerToken ? startProjectionHeartbeat(env, row, ownerToken) : null;

  try {
    let remote: FeishuRecord;
    try {
      remote = await getBaseRecord(env, recordId);
    } catch (error) {
      throw new RecoverableProjectionError(`Projection verification read failed: ${redactError(error)}`, ownerToken);
    }
    const markerMatches = projectionMarker(env, remote, projectionSource(row));
    const authoritative = await entity(env, taskId);
    if (!ownerToken) row = await command(env, row.command_id) ?? row;
    const newerVersion = (authoritative?.version ?? -1) > claimedVersion;
    const expiredOwner = !markerMatches && !newerVersion && (row.projection_lease_until ?? 0) <= now();
    if ((markerMatches || newerVersion || expiredOwner) && !ownerToken) {
      ownerToken = await claimProjectionRecovery(env, row, expiredOwner);
      if (!ownerToken) {
        const durable = await receiptForCommand(env, row.command_id);
        if (durable?.status === "succeeded") return deliverSuccessNotification(env, await command(env, row.command_id) ?? row, durable, notifyOpenId);
        throw new Error("Projection recovery ownership was fenced");
      }
      recoveredExpiredOwner = expiredOwner;
      stopHeartbeat = startProjectionHeartbeat(env, row, ownerToken);
    }
    if (markerMatches && ownerToken) row = await markProjectionApplied(env, row, ownerToken);
    if (newerVersion && !row.projection_applied_at) {
      if (!ownerToken) throw new Error("Projection recovery ownership disappeared");
      return finishUnknown(env, row, ownerToken, "这次历史投影无法确认是否曾应用，且已被较新版本取代", authoritative, notifyOpenId);
    }
    if (markerMatches || newerVersion) {
      await reconcileProjection(env, taskId, recordId, claimedVersion);
      return finalizeProjection(env, row, prepared.receipt, notifyOpenId, ownerToken);
    }
    if (!ownerToken || (!prepared.acquired && !recoverUnmarked && !recoveredExpiredOwner)) throw new Error("Projection is still in flight; replay will verify its durable marker");
    if (!await renewProjectionLease(env, row.command_id, ownerToken)) throw new RecoverableProjectionError("Projection owner was fenced before Base write", ownerToken);

    try {
      await writeBaseRecord(env, recordId, targetState, projectionSource(row), { rawInput: row.raw_input, reason: row.reason });
    } catch (error) {
      throw new RecoverableProjectionError(`Projection write failed: ${redactError(error)}`, ownerToken);
    }
    try {
      row = await markProjectionApplied(env, row, ownerToken);
    } catch (error) {
      await reconcileProjection(env, taskId, recordId, claimedVersion);
      const durable = await receiptForCommand(env, row.command_id);
      if (durable?.status === "succeeded") return deliverSuccessNotification(env, await command(env, row.command_id) ?? row, durable, notifyOpenId);
      throw error;
    }
    await reconcileProjection(env, taskId, recordId, claimedVersion);
    return finalizeProjection(env, row, prepared.receipt, notifyOpenId, ownerToken);
  } finally {
    stopHeartbeat?.();
  }
}

async function executeCommand(env: Env, commandId: string, notifyOpenId?: string, maxChecks = 3) {
  let lastError: unknown = new Error("Projection did not run");
  let recoverUnmarked = false;
  for (let attempt = 0; attempt < maxChecks; attempt += 1) {
    try {
      return await executeProjectionPass(env, commandId, notifyOpenId, recoverUnmarked);
    } catch (error) {
      lastError = error;
      recoverUnmarked ||= error instanceof RecoverableProjectionError;
      const row = await command(env, commandId);
      if (!row || !["projection_prepared", "projection_inflight"].includes(row.status)) throw error;
      if (error instanceof RecoverableProjectionError && error.ownerToken && row.status === "projection_inflight") {
        const released = await env.DB.prepare(`UPDATE commands SET status = 'projection_prepared', projection_token = NULL, projection_lease_until = NULL, updated_at = ?
          WHERE command_id = ? AND status = 'projection_inflight' AND projection_token = ?`)
          .bind(now(), row.command_id, error.ownerToken).run();
        if ((released.meta.changes ?? 0) === 1) {
          await env.DB.prepare("UPDATE runs SET status = 'projection_prepared' WHERE run_id = ? AND status = 'projection_inflight'").bind(row.run_id).run();
        }
      }
      try { await appendEvent(env, row.command_id, row.run_id, "projection_recovery", { attempt: attempt + 1, message: redactError(error) }); } catch { /* Retry must not depend on display events. */ }
    }
  }
  throw new Error(`Projection remains recoverable after ${maxChecks} checks: ${redactError(lastError)}`);
}

function mapProjects(records: FeishuRecord[], entities: Map<string, EntityRow>) {
  const projects = new Map<string, {
    id: string; code: string; name: string; shortName: string; goal: string; due: string; accent: string;
    tasks: Array<{ recordId: string; id: string; title: string; done: boolean; stage: TaskStage; version: number; owner: "我" | "Agent" | "一起"; priority: "high" | "normal"; relation: string }>;
  }>();
  for (const record of records) {
    const fields = record.fields ?? {};
    const shortName = fieldText(fields["项目"], "未归档");
    const projectId = fieldText(fields.project_id, shortName);
    if (!projects.has(projectId)) {
      projects.set(projectId, {
        id: projectId,
        code: fieldText(fields["项目代号"], shortName.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, "").trim().slice(0, 10) || "OPS"),
        name: shortName,
        shortName,
        goal: fieldText(fields["项目目标"], "等待补充目标"),
        due: dueText(fields["截止"]),
        accent: fieldText(fields["强调色"], "#5f7eff"),
        tasks: [],
      });
    }
    const taskId = taskIdForRecord(record);
    const owner = fieldText(fields["执行者"] ?? fields["谁在干"], "我");
    const authoritative = entities.get(taskId);
    const stage = authoritative?.stage ?? stageFromFields(fields);
    const priority = fieldText(fields["优先级"]);
    projects.get(projectId)!.tasks.push({
      recordId: record.record_id,
      id: taskId,
      title: fieldText(fields["任务"], "未命名任务"),
      done: stage === "done",
      stage,
      version: authoritative?.version ?? 0,
      owner: owner.includes("🤖") || owner.includes("Agent") || owner.includes("Codex") || owner.includes("Claude") || owner.includes("Jarvis") || /\bCC\b/i.test(owner) ? "Agent" : owner.includes("一起") ? "一起" : "我",
      priority: priority === "high" || priority.includes("P0") ? "high" : "normal",
      relation: fieldText(fields["关系"] ?? fields["下一步"], "未分类"),
    });
  }
  return [...projects.values()];
}

async function liveLedger(env: Env) {
  const [commandsResult, eventsResult, receiptsResult] = await Promise.all([
    env.DB.prepare("SELECT * FROM commands ORDER BY created_at DESC LIMIT 20").all<CommandRow>(),
    env.DB.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 100").all<{ event_id: string; command_id: string; run_id: string; kind: string; detail_json: string; created_at: number }>(),
    env.DB.prepare("SELECT * FROM receipts ORDER BY created_at DESC LIMIT 20").all<ReceiptRow>(),
  ]);
  const eventsByCommand = new Map<string, Array<{ time: string; label: string; detail: string }>>();
  for (const event of eventsResult.results.reverse()) {
    let detail: Record<string, unknown> = {};
    try { detail = JSON.parse(event.detail_json) as Record<string, unknown>; } catch { /* Stored details are best-effort display data. */ }
    const items = eventsByCommand.get(event.command_id) ?? [];
    items.push({
      time: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Australia/Brisbane" }).format(new Date(event.created_at)),
      label: event.kind,
      detail: String(detail.message ?? detail.receiptId ?? detail.taskId ?? event.kind),
    });
    eventsByCommand.set(event.command_id, items);
  }
  const receiptByCommand = new Map(receiptsResult.results.map((receipt) => [receipt.command_id, receipt]));
  const runs = commandsResult.results.map((row) => {
    const receipt = receiptByCommand.get(row.command_id);
    const presentation = ledgerPresentation(row.status, row.error ?? row.reason, receipt?.receipt_id);
    const stage = presentation.stage;
    return {
      id: row.run_id,
      commandId: row.command_id,
      agentId: "builder",
      projectId: "",
      taskId: row.task_id ?? "",
      stage,
      step: stage === "done" ? 2 : stage === "review" ? 1 : 0,
      status: row.status,
      eta: presentation.eta,
      events: eventsByCommand.get(row.command_id) ?? [],
      artifact: stage === "failed" ? { kind: presentation.artifactKind, title: receipt?.receipt_id ?? `失败运行 ${row.run_id}`, summary: presentation.summary ?? row.error ?? "执行失败" }
        : stage === "review" ? { kind: presentation.artifactKind, title: row.task_id ? `候选任务 ${row.task_id}` : "需要更多信息", summary: row.reason ?? "等待人工判断" }
          : receipt ? { kind: presentation.artifactKind, title: receipt.receipt_id, summary: `${row.run_id} · entity v${receipt.entity_version} · ${receipt.status} · 飞书回执 ${receipt.notification_status}` } : undefined,
      model: row.model_response_id ? { provider: row.model_provider, name: row.model_name, responseId: row.model_response_id } : null,
    };
  });
  return { runs, receipts: receiptsResult.results };
}

function agentAccent(agentId: string) {
  const palette = ["#5f7eff", "#e68a5c", "#6fd0ad", "#b978e8", "#d3a83d", "#4aa9c7"];
  return palette[[...agentId].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % palette.length];
}

async function agentCollaboration(env: Env) {
  const [eventsResult, messagesResult, receiptsResult] = await Promise.all([
    env.DB.prepare("SELECT * FROM agent_events ORDER BY occurred_at DESC, created_at DESC LIMIT 200").all<AgentEventRow>(),
    env.DB.prepare("SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT 100").all<AgentMessageRow>(),
    env.DB.prepare("SELECT * FROM agent_receipts ORDER BY created_at DESC LIMIT 100").all<AgentReceiptRow>(),
  ]);
  const byRun = new Map<string, AgentEventRow[]>();
  for (const event of eventsResult.results.slice().reverse()) {
    const items = byRun.get(event.run_id) ?? [];
    items.push(event);
    byRun.set(event.run_id, items);
  }
  const runs = [...byRun.entries()].map(([runId, events]) => {
    const latest = events.at(-1)!;
    const stage = latest.state === "done" ? "done" : latest.state === "failed" ? "failed" : new Set(["waiting", "blocked"]).has(latest.state) ? "review" : "running";
    const artifactEvent = events.findLast((event) => event.kind === "artifact") ?? (latest.state === "blocked" || latest.state === "failed" ? latest : null);
    return {
      id: runId,
      commandId: null,
      agentId: latest.agent_id,
      agentName: latest.agent_name,
      agentMark: latest.agent_name.trim().slice(0, 1).toUpperCase() || "A",
      agentAccent: agentAccent(latest.agent_id),
      projectId: "",
      taskId: latest.task_id ?? "",
      stage,
      step: events.length,
      status: latest.title,
      eta: stage === "done" ? "已完成" : stage === "failed" ? "失败已留证" : stage === "review" ? "等待用户" : "运行中",
      events: events.map((event) => ({
        time: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(event.occurred_at)),
        label: event.title,
        detail: event.detail,
      })),
      artifact: artifactEvent ? {
        kind: artifactEvent.kind === "artifact" ? "AGENT ARTIFACT" : artifactEvent.state === "failed" ? "AGENT FAILURE" : "AGENT BLOCKER",
        title: artifactEvent.title,
        summary: artifactEvent.detail,
        url: artifactEvent.artifact_url,
      } : undefined,
      model: null,
    };
  });
  return {
    runs,
    messages: messagesResult.results.map(messageJson),
    receipts: receiptsResult.results.map(receiptJson),
  };
}

async function collaborationEvents(env: Env) {
  const result = await env.DB.prepare("SELECT * FROM source_events WHERE source = 'collab_board' ORDER BY occurred_at DESC, created_at DESC LIMIT 30").all<SourceEventRow>();
  return result.results.map((row) => ({
    id: row.source_event_id,
    source: row.source,
    occurredAt: row.occurred_at,
    actor: row.actor,
    title: row.title,
    status: row.status,
    detail: row.detail,
    sourcePath: row.source_path,
    taskId: row.task_id,
  }));
}

async function handleCollaborationIngest(request: Request, env: Env) {
  const expected = required(env, "MAXOPS_INGEST_TOKEN");
  if (!await fixedEqual(bearer(request), expected)) return json({ error: "Invalid ingest token" }, { status: 401 });
  const payload = await request.json() as { events?: unknown };
  if (!Array.isArray(payload.events) || payload.events.length > 50) return json({ error: "events must contain at most 50 items" }, { status: 400 });
  const stamp = now();
  const rows = payload.events.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Invalid event at ${index}`);
    const event = item as Record<string, unknown>;
    const fields = ["id", "actor", "title", "status", "detail", "sourcePath", "sourceHash"] as const;
    for (const field of fields) {
      if (typeof event[field] !== "string" || !event[field] || String(event[field]).length > (field === "detail" ? 4000 : 500)) throw new Error(`Invalid ${field} at ${index}`);
    }
    const occurredAt = Number(event.occurredAt);
    if (!Number.isFinite(occurredAt) || occurredAt < 0) throw new Error(`Invalid occurredAt at ${index}`);
    const taskId = event.taskId === undefined || event.taskId === null || event.taskId === "" ? null : String(event.taskId);
    if (taskId && taskId.length > 200) throw new Error(`Invalid taskId at ${index}`);
    return {
      id: String(event.id), actor: String(event.actor), title: String(event.title), status: String(event.status),
      detail: String(event.detail), sourcePath: String(event.sourcePath), sourceHash: String(event.sourceHash), occurredAt, taskId,
    };
  });
  if (!rows.length) return json({ ok: true, inserted: 0, total: 0 });
  const results = await env.DB.batch(rows.map((row) => env.DB.prepare(`INSERT OR IGNORE INTO source_events
    (source_event_id, source, occurred_at, actor, title, status, detail, source_path, source_hash, task_id, created_at)
    VALUES (?, 'collab_board', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, row.occurredAt, row.actor, row.title, row.status, row.detail, row.sourcePath, row.sourceHash, row.taskId, stamp)));
  return json({ ok: true, inserted: results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0), total: rows.length });
}

async function handleAgentApi(request: Request, env: Env, url: URL) {
  const credential = await authenticateAgent(request, env);
  if (url.pathname === "/api/agent/v1/health" && request.method === "GET") {
    return json({ ok: true, api: "OPS Agent API", version: "v1", credential_mode: credential.mode, server_time: now() });
  }
  const taskReadMatch = url.pathname.match(/^\/api\/agent\/v1\/tasks\/([^/]+)$/);
  if (taskReadMatch && request.method === "GET") {
    const recordId = decodeURIComponent(taskReadMatch[1]);
    assertAgentScope(credential, { recordId });
    const record = await getBaseRecord(env, recordId);
    const project = mapProjects([record], new Map())[0];
    const task = project?.tasks[0];
    if (!project || !task) return json({ error: "Task not found" }, { status: 404 });
    assertAgentScope(credential, { taskId: task.id, recordId: task.recordId });
    return json({
      ok: true,
      source: "feishu",
      read_at: now(),
      project: { id: project.id, name: project.name, short_name: project.shortName, goal: project.goal, due: project.due },
      task: {
        task_id: task.id,
        record_id: task.recordId,
        title: task.title,
        stage: task.stage,
        owner: task.owner,
        priority: task.priority,
        relation: task.relation,
      },
    });
  }
  if (url.pathname === "/api/agent/v1/events" && request.method === "POST") {
    const result = await createAgentEvent(request, env, credential);
    return json({
      ok: true,
      idempotent: !result.created,
      event: result.event ? {
        event_id: result.event.event_id,
        run_id: result.event.run_id,
        agent_id: result.event.agent_id,
        task_id: result.event.task_id,
        record_id: result.event.record_id,
        kind: result.event.kind,
        state: result.event.state,
        occurred_at: result.event.occurred_at,
      } : null,
      receipt: receiptJson(result.receipt),
    }, { status: result.created ? 201 : 200 });
  }
  if (url.pathname === "/api/agent/v1/questions" && request.method === "POST") {
    const result = await createAgentQuestion(request, env, credential);
    return json({ ok: true, idempotent: !result.created, message: result.message ? messageJson(result.message) : null, receipt: receiptJson(result.receipt) }, { status: result.created ? 201 : 200 });
  }
  if (url.pathname === "/api/agent/v1/inbox" && request.method === "GET") {
    return json({ ok: true, messages: await agentInbox(url, env, credential), delivery: "at-least-once; POST a delivered or acknowledged receipt for every message" });
  }
  const receiptMatch = url.pathname.match(/^\/api\/agent\/v1\/messages\/([^/]+)\/receipts$/);
  if (receiptMatch && request.method === "POST") {
    const result = await recordMessageReceipt(request, env, decodeURIComponent(receiptMatch[1]), credential);
    return json({ ok: true, idempotent: !result.created, message: result.message ? messageJson(result.message) : null, receipt: receiptJson(result.receipt) }, { status: result.created ? 201 : 200 });
  }
  return json({ error: "Agent API route not found" }, { status: 404 });
}

async function authenticated(request: Request, env: Env) {
  return readSession(request, required(env, "FEISHU_H5_APP_SECRET"));
}

async function processNewFeishuCommand(env: Env, row: CommandRow, openId: string) {
  const leaseMs = processingLeaseMs(env.COMMAND_PROCESSING_LEASE_MS);
  if (row.status === "processing" && (row.processing_lease_until ?? 0) > now()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(leaseMs, (row.processing_lease_until ?? now()) - now() + 10)));
  }
  row = await command(env, row.command_id) ?? row;
  if (row.status === "processing" && row.processing_stage === "model_inflight" && (row.processing_lease_until ?? 0) <= now()) {
    if (await expireModelInflight(env, row, openId)) await flushCommandNotifications(env, row.command_id);
    return;
  }
  const leaseToken = id("lease");
  const leaseStamp = now();
  const routingText = `🛰️ 已收到，正在用 AI 匹配任务\nrun: ${row.run_id}`;
  const routingValues = await notificationValues(env, row, "routing_received", openId, routingText);
  const claimed = await env.DB.batch([
    env.DB.prepare(`UPDATE commands SET status = 'processing', processing_token = ?, processing_lease_until = ?, processing_stage = 'routing', updated_at = ?
      WHERE command_id = ? AND (status = 'queued' OR (status = 'processing' AND COALESCE(processing_lease_until, 0) <= ?))`)
      .bind(leaseToken, leaseStamp + leaseMs, leaseStamp, row.command_id, leaseStamp),
    env.DB.prepare(`UPDATE runs SET status = 'processing' WHERE run_id = ?
      AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'processing' AND processing_token = ?)`)
      .bind(row.run_id, row.command_id, leaseToken),
    notificationInsert(env, row, "routing_received", routingValues, leaseStamp, "processing"),
  ]);
  if ((claimed[0].meta.changes ?? 0) !== 1) return;
  row = await command(env, row.command_id) ?? row;
  const renewLease = async () => {
    const stamp = now();
    const renewed = await env.DB.prepare("UPDATE commands SET processing_lease_until = ?, updated_at = ? WHERE command_id = ? AND status = 'processing' AND processing_token = ?")
      .bind(stamp + leaseMs, stamp, row.command_id, leaseToken).run();
    return (renewed.meta.changes ?? 0) === 1;
  };
  try {
    await flushNotification(env, routingValues.notificationId);
    if (!await renewLease()) return;
    const observedVersions = await entityVersions(env);
    const records = await listBaseRecords(env);
    if (!await renewLease()) return;
    const tasks = taskCandidates(records);
    await hydrateEntities(env, tasks, observedVersions);
    if (!await renewLease()) return;
    const modelStarted = await env.DB.prepare("UPDATE commands SET processing_stage = 'model_inflight', updated_at = ? WHERE command_id = ? AND status = 'processing' AND processing_token = ?")
      .bind(now(), row.command_id, leaseToken).run();
    if ((modelStarted.meta.changes ?? 0) !== 1) return;
    const { decision, responseId, model, provider } = await callIntentModel(env, row.raw_input, tasks, row.actor_hash);
    if (!await renewLease()) return;
    if (decision.intent !== "task_state_update") {
      const stamp = now();
      const candidateHints = tasks.slice(0, 5)
        .map((task) => `- ${task.projectName} / ${task.title}（${stageDisplay(task.stage)}）`)
        .join("\n");
      const candidateSummary = candidateHints
        ? `\n当前可更新的任务：\n${candidateHints}${tasks.length > 5 ? `\n…共 ${tasks.length} 项` : ""}`
        : "\n当前没有读取到可更新任务。";
      const needsInputText = `我没有找到明确的“任务 + 新状态”，所以没有改任务。\n你可以直接说：把「任务名」改成「待办 / 进行中 / 等外部 / 完成 / 放弃」。${candidateSummary}\n原因：${decision.reason}\nrun: ${row.run_id}`;
      const needsInputValues = await notificationValues(env, row, "model_needs_input", openId, needsInputText);
      const decided = await env.DB.batch([
        env.DB.prepare("UPDATE commands SET intent = ?, confidence = ?, reason = ?, status = 'needs_input', processing_token = NULL, processing_lease_until = NULL, processing_stage = NULL, model_provider = ?, model_name = ?, model_response_id = ?, updated_at = ? WHERE command_id = ? AND status = 'processing' AND processing_token = ?")
          .bind(decision.intent, decision.confidence, decision.reason, provider, model, responseId, stamp, row.command_id, leaseToken),
        env.DB.prepare(`UPDATE runs SET status = 'needs_input', provider = ?, model = ? WHERE run_id = ?
          AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'needs_input' AND model_response_id = ?)`)
          .bind(provider, model, row.run_id, row.command_id, responseId),
        notificationInsert(env, row, "model_needs_input", needsInputValues, stamp, "needs_input"),
      ]);
      if ((decided[0].meta.changes ?? 0) !== 1) return;
      try { await appendEvent(env, row.command_id, row.run_id, "model_needs_input", { responseId, reason: decision.reason }); } catch { /* Display-only. */ }
      await flushNotification(env, needsInputValues.notificationId);
      return;
    }
    const task = tasks.find((candidate) => candidate.id === decision.entity);
    if (!task) throw new Error("Resolved task disappeared");
    const current = await entity(env, task.id);
    if (!current) throw new Error("Resolved task has no ledger entity");
    const targetStage = normalizedTargetStage(decision.target_state);
    const targetDone = targetStage === "done";
    const stamp = now();
    const gateText = `🛂 请确认写回\n候选：${task.projectName} / ${task.title}\nbefore: ${stageDisplay(current.stage)} (v${current.version})\nafter: ${stageDisplay(targetStage)} (v${current.version + 1})\n置信度：${Math.round(decision.confidence * 100)}%\n原因：${decision.reason}\n\n回复：确认 ${row.command_id}\n取消：取消 ${row.command_id}\nrun: ${row.run_id}`;
    const gateValues = await notificationValues(env, row, "gate_request", openId, gateText);
    const decided = await env.DB.batch([
      env.DB.prepare(`UPDATE commands SET intent = ?, task_id = ?, record_id = ?, target_state = ?, confidence = ?, reason = ?,
        status = 'needs_confirmation', processing_token = NULL, processing_lease_until = NULL, processing_stage = NULL, expected_version = ?, model_provider = ?, model_name = ?, model_response_id = ?, updated_at = ?
        WHERE command_id = ? AND status = 'processing' AND processing_token = ?`)
        .bind(decision.intent, task.id, task.recordId, decision.target_state, decision.confidence, decision.reason, current.version, provider, model, responseId, stamp, row.command_id, leaseToken),
      env.DB.prepare(`UPDATE runs SET status = 'needs_confirmation', provider = ?, model = ? WHERE run_id = ?
        AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'needs_confirmation' AND model_response_id = ?)`)
        .bind(provider, model, row.run_id, row.command_id, responseId),
      env.DB.prepare(`INSERT OR IGNORE INTO gates (gate_id, command_id, status, before_json, after_json, requested_at, decided_at, decided_by_hash)
        SELECT ?, ?, 'pending', ?, ?, ?, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'needs_confirmation' AND model_response_id = ?)`)
        .bind(id("gate"), row.command_id, JSON.stringify({ taskId: task.id, title: task.title, done: Boolean(current.state), stage: current.stage, version: current.version }), JSON.stringify({ taskId: task.id, title: task.title, done: targetDone, stage: targetStage, version: current.version + 1 }), stamp, row.command_id, responseId),
      notificationInsert(env, row, "gate_request", gateValues, stamp, "needs_confirmation"),
    ]);
    if ((decided[0].meta.changes ?? 0) !== 1) return;
    try { await appendEvent(env, row.command_id, row.run_id, "model_resolved", { responseId, taskId: task.id, confidence: decision.confidence }); } catch { /* Display-only. */ }
    try { await appendEvent(env, row.command_id, row.run_id, "gate_requested", { taskId: task.id, before: Boolean(current.state), after: targetDone, version: current.version }); } catch { /* Display-only. */ }
    await flushNotification(env, gateValues.notificationId);
  } catch (error) {
    const durable = await command(env, row.command_id);
    if (durable?.status === "processing" && durable.processing_token === leaseToken) await finishFailure(env, durable, redactError(error), openId);
  }
}

async function executeApprovedCommand(env: Env, row: CommandRow, openId: string) {
  const startId = await enqueueNotification(env, row, "projection_start", openId, `确认收到，正在写回。\nrun: ${row.run_id}`);
  void flushNotification(env, startId);
  try {
    await executeCommand(env, row.command_id, openId);
  } catch (error) {
    const durable = await command(env, row.command_id);
    const receipt = await receiptForCommand(env, row.command_id);
    if (durable && ["failed", "succeeded", "superseded_unknown"].includes(durable.status)) {
      await flushCommandNotifications(env, row.command_id);
      return;
    }
    if (durable && ["projection_prepared", "projection_inflight"].includes(durable.status)) {
      try { await appendEvent(env, row.command_id, row.run_id, "projection_pending", { message: redactError(error), receiptId: receipt?.receipt_id }); } catch { /* Display-only. */ }
      await notifyDurably(env, row, "projection_pending", openId, `⚠️ 写回尚未确认完成，命令保持可恢复状态。\nrun: ${row.run_id}\nreceipt: ${receipt?.receipt_id ?? "pending"}\n原因：${redactError(error)}`);
      return;
    }
    if (durable) await finishFailure(env, durable, redactError(error), openId);
  }
}

async function handleGateReply(env: Env, gate: { action: "confirm" | "cancel"; commandId: string }, openId: string, messageId: string, ctx: ExecutionContext) {
  const row = await command(env, gate.commandId);
  if (!row || row.actor_hash !== await actorHash(openId)) {
    ctx.waitUntil(sendBotText(env, openId, "这条确认已失效、已处理，或不属于当前账号；没有写回。"));
    return { status: "rejected", commandId: null, runId: null };
  }
  if (row.status !== "needs_confirmation") {
    ctx.waitUntil((async () => {
      await flushCommandNotifications(env, row.command_id);
      if (gate.action === "confirm" && ["confirmed", "projection_prepared", "projection_inflight"].includes(row.status)) await executeApprovedCommand(env, row, openId);
    })());
    return { status: `duplicate_${row.status}`, commandId: row.command_id, runId: row.run_id };
  }
  const stamp = now();
  if (gate.action === "cancel") {
    const cancelValues = await notificationValues(env, row, "gate_cancelled", openId, `已取消，没有写回。\nrun: ${row.run_id}`);
    const cancelled = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO events (event_id, command_id, run_id, kind, detail_json, created_at) VALUES (?, ?, ?, 'gate_reply_received', ?, ?)")
        .bind(`feishu:${messageId}`, row.command_id, row.run_id, JSON.stringify({ action: gate.action }), stamp),
      env.DB.prepare("UPDATE commands SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE command_id = ? AND status = 'needs_confirmation'")
        .bind(stamp, stamp, row.command_id),
      env.DB.prepare("UPDATE runs SET status = 'cancelled', completed_at = ? WHERE run_id = ? AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'cancelled')")
        .bind(stamp, row.run_id, row.command_id),
      env.DB.prepare("UPDATE gates SET status = 'cancelled', decided_at = ?, decided_by_hash = ? WHERE command_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'cancelled')")
        .bind(stamp, row.actor_hash, row.command_id, row.command_id),
      notificationInsert(env, row, "gate_cancelled", cancelValues, stamp, "cancelled"),
    ]);
    if ((cancelled[0].meta.changes ?? 0) !== 1 || (cancelled[1].meta.changes ?? 0) !== 1) throw new Error("Gate cancellation was not durably recorded");
    ctx.waitUntil(flushNotification(env, cancelValues.notificationId));
    return { status: "cancelled", commandId: row.command_id, runId: row.run_id };
  }
  const approved = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO events (event_id, command_id, run_id, kind, detail_json, created_at) VALUES (?, ?, ?, 'gate_reply_received', ?, ?)")
      .bind(`feishu:${messageId}`, row.command_id, row.run_id, JSON.stringify({ action: gate.action }), stamp),
    env.DB.prepare("UPDATE commands SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE command_id = ? AND status = 'needs_confirmation'")
      .bind(stamp, stamp, row.command_id),
    env.DB.prepare("UPDATE runs SET status = 'confirmed' WHERE run_id = ? AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'confirmed')")
      .bind(row.run_id, row.command_id),
    env.DB.prepare("UPDATE gates SET status = 'approved', decided_at = ?, decided_by_hash = ? WHERE command_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'confirmed')")
      .bind(stamp, row.actor_hash, row.command_id, row.command_id),
    env.DB.prepare(`INSERT OR IGNORE INTO notification_outbox
      (notification_id, command_id, run_id, kind, recipient_ciphertext, body_text, status, attempts, lease_until, created_at, updated_at)
      SELECT ?, ?, ?, 'projection_start', ?, ?, 'pending', 0, NULL, ?, ?
      WHERE EXISTS (SELECT 1 FROM commands WHERE command_id = ? AND status = 'confirmed')`)
      .bind(`ntf_${(await sha256(`${row.command_id}:projection_start`)).slice(0, 40)}`, row.command_id, row.run_id,
        await sealStoredValue(openId, required(env, "FEISHU_H5_APP_SECRET")), `确认收到，正在写回。\nrun: ${row.run_id}`, stamp, stamp, row.command_id),
  ]);
  if ((approved[0].meta.changes ?? 0) !== 1 || (approved[1].meta.changes ?? 0) !== 1) throw new Error("Gate approval was not durably recorded");
  ctx.waitUntil(executeApprovedCommand(env, row, openId));
  return { status: "confirmed", commandId: row.command_id, runId: row.run_id };
}

async function persistFeishuEventReceipt(env: Env, input: {
  eventId: string;
  eventType: string;
  messageId: string | null;
  status: string;
  commandId: string | null;
  runId: string | null;
  fingerprint: string;
}) {
  const existing = await env.DB.prepare("SELECT * FROM feishu_event_receipts WHERE event_id = ?").bind(input.eventId).first<FeishuEventReceiptRow>();
  if (existing) {
    assertIdempotentPayload(existing.payload_fingerprint, input.fingerprint);
    return existing;
  }
  try {
    await env.DB.prepare(`INSERT INTO feishu_event_receipts
      (event_id, payload_fingerprint, event_type, message_id, status, command_id, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(input.eventId, input.fingerprint, input.eventType, input.messageId, input.status, input.commandId, input.runId, now()).run();
  } catch (error) {
    const raced = await env.DB.prepare("SELECT * FROM feishu_event_receipts WHERE event_id = ?").bind(input.eventId).first<FeishuEventReceiptRow>();
    if (!raced) throw error;
    assertIdempotentPayload(raced.payload_fingerprint, input.fingerprint);
    return raced;
  }
  const receipt = await env.DB.prepare("SELECT * FROM feishu_event_receipts WHERE event_id = ?").bind(input.eventId).first<FeishuEventReceiptRow>();
  if (!receipt) throw new Error("Feishu event receipt was not visible after insert");
  return receipt;
}

function feishuEventReceiptJson(row: FeishuEventReceiptRow) {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    message_id: row.message_id,
    status: row.status,
    command_id: row.command_id,
    run_id: row.run_id,
    created_at: row.created_at,
  };
}

async function handleFeishuEvent(request: Request, env: Env, ctx: ExecutionContext) {
  const payload = await boundedJson(request, 64 * 1024) as {
    challenge?: string;
    token?: string;
    encrypt?: string;
    type?: string;
    header?: { token?: string; event_type?: string; event_id?: string };
    event?: {
      sender?: { sender_id?: { open_id?: string }; sender_type?: string };
      message?: { message_id?: string; message_type?: string; content?: string; chat_type?: string };
    };
  };
  if (payload.encrypt) return json({ error: "Encrypted callbacks are not enabled for this endpoint" }, { status: 400 });
  const suppliedToken = payload.header?.token ?? payload.token ?? "";
  const callbackAuthorized = env.FEISHU_EVENT_VERIFICATION_TOKEN
    ? await fixedEqual(suppliedToken, env.FEISHU_EVENT_VERIFICATION_TOKEN)
    : false;
  const connectorAuthorized = env.MAXOPS_FEISHU_CONNECTOR_TOKEN
    ? await fixedEqual(bearer(request), env.MAXOPS_FEISHU_CONNECTOR_TOKEN)
    : false;
  if (!callbackAuthorized && !connectorAuthorized) return json({ error: "Invalid event token" }, { status: 401 });
  if (payload.type === "url_verification" && payload.challenge) return json({ challenge: payload.challenge });
  const eventType = payload.header?.event_type ?? payload.type ?? "unknown";
  const messageId = payload.event?.message?.message_id ?? "";
  const eventId = cleanString(payload.header?.event_id || messageId, "event_id", 200);
  const fingerprint = await payloadFingerprint("feishu-event", [payload]);
  const durableResponse = async (status: string, commandId: string | null, runId: string | null, extra: Record<string, unknown> = {}) => {
    const receipt = await persistFeishuEventReceipt(env, {
      eventId, eventType, messageId: messageId || null, status, commandId, runId, fingerprint,
    });
    return json({ ok: true, durable: true, receipt: feishuEventReceiptJson(receipt), ...extra }, { status: 202 });
  };
  if (payload.header?.event_type !== "im.message.receive_v1") return durableResponse("ignored_event_type", null, null, { ignored: true });
  const openId = payload.event?.sender?.sender_id?.open_id ?? "";
  const messageType = payload.event?.message?.message_type;
  const senderType = payload.event?.sender?.sender_type;
  const chatType = payload.event?.message?.chat_type;
  if (!openId || !messageId || messageType !== "text" || senderType !== "user" || chatType !== "p2p") return durableResponse("ignored_message_shape", null, null, { ignored: true });
  const senderHash = await assertAllowed(openId, env);
  const text = parseFeishuText(payload.event?.message?.content ?? "");
  if (!text) return durableResponse("ignored_empty_text", null, null, { ignored: true });

  const gate = parseGateReply(text);
  if (gate) {
    const result = await handleGateReply(env, gate, openId, messageId, ctx);
    return durableResponse(result.status, result.commandId, result.runId, { accepted: true, kind: "gate" });
  }

  const created = await createCommand(env, {
    idempotencyKey: `feishu:${messageId}`,
    source: "feishu",
    sourceEventId: messageId,
    actorHash: senderHash,
    rawInput: text,
    status: "queued",
    recoveryNotification: { kind: "routing_received", openId, text: "🛰️ 已收到，正在用 AI 匹配任务\nrun: {run_id}" },
  });
  await appendEvent(env, created.row.command_id, created.row.run_id, "message_received", { source: "feishu" }, `feishu:${messageId}`);
  const receiptResponse = await durableResponse(created.created ? "accepted" : "duplicate", created.row.command_id, created.row.run_id, {
    accepted: created.created,
    duplicate: !created.created,
    commandId: created.row.command_id,
    runId: created.row.run_id,
  });
  if (!created.created) {
    const requeued = shouldResumeQueuedCommand(created.row);
    if (requeued) ctx.waitUntil(processNewFeishuCommand(env, created.row, openId));
    else ctx.waitUntil((async () => {
      await flushCommandNotifications(env, created.row.command_id);
      if (["confirmed", "projection_prepared", "projection_inflight"].includes(created.row.status)) await executeApprovedCommand(env, created.row, openId);
    })());
    const body = await receiptResponse.json() as Record<string, unknown>;
    return json({ ...body, requeued }, { status: 200 });
  }
  ctx.waitUntil(processNewFeishuCommand(env, created.row, openId));
  return receiptResponse;
}

async function handleFeishu(request: Request, env: Env, url: URL, ctx: ExecutionContext) {
  if (url.pathname === "/api/feishu/events" && request.method === "POST") return handleFeishuEvent(request, env, ctx);

  if (url.pathname === "/api/feishu/ws-config" && request.method === "POST") {
    const expected = required(env, "MAXOPS_FEISHU_CONNECTOR_TOKEN");
    if (!await fixedEqual(bearer(request), expected)) return json({ error: "Invalid connector token" }, { status: 401 });
    const appId = required(env, "FEISHU_H5_APP_ID");
    const appSecret = required(env, "FEISHU_H5_APP_SECRET");
    const config = await feishu<{ data: { URL: string; ClientConfig: Record<string, unknown> } }>("https://open.feishu.cn/callback/ws/endpoint", {
      method: "POST",
      headers: { "content-type": "application/json", locale: "zh", "user-agent": "max-ops-connector/1" },
      body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
    });
    return json(config);
  }

  if (url.pathname === "/api/feishu/login" && request.method === "GET") {
    // Feishu's authorization page is a cross-site hop. Some browsers and
    // embedded webviews do not return the short-lived state cookie after that
    // hop, so keep the OAuth state self-verifying as well as cookie-bound.
    const state = await sealStoredValue(JSON.stringify({
      nonce: base64Url(crypto.getRandomValues(new Uint8Array(18))),
      exp: now() + 10 * 60 * 1000,
    }), required(env, "FEISHU_H5_APP_SECRET"));
    const callback = `${url.origin}/api/feishu/callback`;
    const target = new URL("https://open.feishu.cn/open-apis/authen/v1/index");
    target.searchParams.set("app_id", required(env, "FEISHU_H5_APP_ID"));
    target.searchParams.set("redirect_uri", callback);
    target.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { location: target.toString(), "set-cookie": cookie(STATE_COOKIE, state, 10 * 60) } });
  }

  if (url.pathname === "/api/feishu/callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const appSecret = required(env, "FEISHU_H5_APP_SECRET");
    let validState = Boolean(state && state === cookies(request)[STATE_COOKIE]);
    if (!validState && state) {
      try {
        const signed = JSON.parse(await openStoredValue(state, appSecret)) as { nonce?: unknown; exp?: unknown };
        validState = typeof signed.nonce === "string"
          && signed.nonce.length >= 16
          && typeof signed.exp === "number"
          && signed.exp > now();
      } catch { /* Invalid or expired signed state. */ }
    }
    if (!code || !validState) return json({ error: "飞书授权状态已过期，请重新打开应用" }, { status: 400 });
    const appId = required(env, "FEISHU_H5_APP_ID");
    const appToken = await appAccessToken(appId, appSecret);
    const exchanged = await feishu<{ data: { access_token: string; open_id?: string } }>("https://open.feishu.cn/open-apis/authen/v1/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${appToken}` },
      body: JSON.stringify({ grant_type: "authorization_code", code }),
    });
    let actor = { openId: exchanged.data.open_id ?? "", name: "飞书用户" };
    try {
      const profile = await feishu<{ data: { open_id: string; name: string } }>("https://open.feishu.cn/open-apis/authen/v1/user_info", {
        headers: { authorization: `Bearer ${exchanged.data.access_token}` },
      });
      actor = { openId: profile.data.open_id, name: profile.data.name || "飞书用户" };
    } catch { /* Profile scope is optional; the verified open_id is sufficient. */ }
    if (!actor.openId) return json({ error: "飞书没有返回用户标识" }, { status: 400 });
    const session = await createSession(actor, appSecret);
    const headers = new Headers({ location: `${url.origin}/?mode=feishu` });
    headers.append("set-cookie", cookie(SESSION_COOKIE, session, 7 * 24 * 60 * 60));
    headers.append("set-cookie", cookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }

  const actor = await authenticated(request, env);
  if (!actor) return json({ mode: "local", authenticated: false, loginUrl: "/api/feishu/login" }, { status: 401 });
  // An authenticated user needs their own opaque hash before an operator can
  // add it to the allowlist. This never returns the raw open_id or any Base data.
  if (url.pathname === "/api/feishu/whoami" && request.method === "GET") return json({ actorHash: await actorHash(actor), name: actor.name });
  const hash = await assertAllowed(actor, env);

  if (url.pathname === "/api/feishu/state" && request.method === "GET") {
    ctx.waitUntil(recoverDurableWork(env));
    if (env.MAXOPS_FRESH_BASE_APP_TOKEN) {
      const fresh = await freshBaseState(env);
      return json({
        mode: "feishu",
        authenticated: true,
        actor: actor.name,
        source: "fresh-copy",
        projects: fresh.projects,
        runs: fresh.runs,
        signals: fresh.signals,
        agentMessages: fresh.messages,
        agentReceipts: fresh.agentReceipts,
        base: fresh.base,
        capabilities: {
          freshBase: true,
          taskWrite: false,
          agentApi: Boolean(env.MAXOPS_AGENT_TOKEN || env.MAXOPS_INGEST_TOKEN),
          aiCommand: false,
          askAiLink: true,
          feishuBotEvents: Boolean(env.FEISHU_EVENT_VERIFICATION_TOKEN),
        },
      });
    }
    const observedVersions = await entityVersions(env);
    const records = await listBaseRecords(env);
    const tasks = taskCandidates(records);
    await hydrateEntities(env, tasks, observedVersions);
    const entityRows = await env.DB.prepare("SELECT * FROM task_entities").all<EntityRow>();
    const [ledger, collaboration, sourceEvents] = await Promise.all([liveLedger(env), agentCollaboration(env), collaborationEvents(env)]);
    return json({
      mode: "feishu",
      authenticated: true,
      actor: actor.name,
      projects: mapProjects(records, new Map(entityRows.results.map((item) => [item.task_id, item]))),
      sourceEvents,
      runs: [...collaboration.runs, ...ledger.runs],
      receipts: ledger.receipts,
      agentMessages: collaboration.messages,
      agentReceipts: collaboration.receipts,
      capabilities: {
        agentApi: Boolean(env.MAXOPS_AGENT_TOKEN || env.MAXOPS_INGEST_TOKEN),
        aiCommand: Boolean(env.OPENAI_API_KEY || (env.MAXOPS_MODEL_PROXY_URL && env.MAXOPS_MODEL_PROXY_TOKEN)),
        feishuBotEvents: Boolean(env.FEISHU_EVENT_VERIFICATION_TOKEN),
      },
    });
  }

  if (url.pathname === "/api/feishu/instructions" && request.method === "POST") {
    const result = await createMaxInstruction(request, env, actor);
    return json({ ok: true, idempotent: !result.created, message: messageJson(result.message), receipt: receiptJson(result.receipt) }, { status: result.created ? 201 : 200 });
  }

  if (url.pathname === "/api/commands/interpret" && request.method === "POST") {
    const payload = await request.json() as { text?: unknown; idempotencyKey?: unknown };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text || text.length > 2000 || typeof payload.idempotencyKey !== "string" || payload.idempotencyKey.length < 12) {
      return json({ error: "Invalid command text" }, { status: 400 });
    }
    const created = await createCommand(env, {
      idempotencyKey: payload.idempotencyKey,
      source: "h5",
      actorHash: hash,
      actorName: actor.name,
      rawInput: text,
      status: "queued",
      recoveryNotification: { kind: "routing_received", openId: actor.openId, text: "🛰️ 已收到，正在用 AI 匹配任务\nrun: {run_id}" },
    });
    if (created.created) {
      await appendEvent(env, created.row.command_id, created.row.run_id, "h5_voice_received", { source: "h5", textLength: text.length });
      ctx.waitUntil(processNewFeishuCommand(env, created.row, actor.openId));
    }
    return json({ ok: true, accepted: created.created, commandId: created.row.command_id, runId: created.row.run_id }, { status: 202 });
  }

  if (url.pathname === "/api/commands" && request.method === "POST") {
    const payload = await request.json() as { taskId?: unknown; recordId?: unknown; targetState?: unknown; expectedVersion?: unknown; idempotencyKey?: unknown; label?: unknown };
    if (typeof payload.taskId !== "string" || typeof payload.recordId !== "string" || !["todo", "running", "waiting", "done", "abandoned", "open"].includes(String(payload.targetState)) || !Number.isInteger(payload.expectedVersion) || typeof payload.idempotencyKey !== "string" || payload.idempotencyKey.length < 12) {
      return json({ error: "Invalid command" }, { status: 400 });
    }
    const observedVersions = await entityVersions(env);
    const currentRecord = await getBaseRecord(env, payload.recordId);
    if (taskIdForRecord(currentRecord) !== payload.taskId) return json({ error: "Task identity mismatch" }, { status: 409 });
    await hydrateEntities(env, taskCandidates([currentRecord]), observedVersions);
    const current = await entity(env, payload.taskId);
    if (!current) return json({ error: "Task entity unavailable" }, { status: 409 });
    const targetState = normalizedTargetStage(String(payload.targetState));
    const created = await createCommand(env, {
      idempotencyKey: payload.idempotencyKey,
      source: "h5",
      actorHash: hash,
      rawInput: typeof payload.label === "string" ? payload.label : payload.taskId,
      status: "confirmed",
      intent: "task_state_update",
      taskId: payload.taskId,
      recordId: payload.recordId,
      targetState,
      confidence: 1,
      reason: "用户在 H5 对明确任务执行了直接确认",
      expectedVersion: Number(payload.expectedVersion),
      modelProvider: "direct_human_gate",
      approvedGate: {
        beforeJson: JSON.stringify({ taskId: payload.taskId, done: Boolean(current.state), stage: current.stage, version: current.version }),
        afterJson: JSON.stringify({ taskId: payload.taskId, done: targetState === "done", stage: targetState, version: current.version + 1 }),
        decidedByHash: hash,
      },
      recoveryNotification: { kind: "projection_start", openId: actor.openId, text: "确认收到，正在写回。\nrun: {run_id}" },
    });
    if (created.created) {
      try { await appendEvent(env, created.row.command_id, created.row.run_id, "h5_gate_approved", { taskId: payload.taskId, before: current.stage, after: targetState }); } catch { /* Display-only. */ }
    }
    const h5StartId = await enqueueNotification(env, created.row, "projection_start", actor.openId, `确认收到，正在写回。\nrun: ${created.row.run_id}`);
    ctx.waitUntil(flushNotification(env, h5StartId));
    try {
      const receipt = await executeCommand(env, created.row.command_id, actor.openId);
      return json({ ok: true, idempotent: !created.created, commandId: created.row.command_id, runId: created.row.run_id, receipt });
    } catch (error) {
      return json({ error: redactError(error), commandId: created.row.command_id, runId: created.row.run_id }, { status: 409 });
    }
  }

  return json({ error: "Not found" }, { status: 404 });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const onboarding = await handleOneClickOnboarding(request, env, ctx);
    if (onboarding) return onboarding;
    if (env.MAXOPS_ONBOARDING_ONLY === "true" && url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, { status: 404 });
    }
    if (url.pathname.startsWith("/api/agent/v1/")) {
      try {
        return await handleAgentApi(request, env, url);
      } catch (error) {
        const message = redactError(error);
        console.error(JSON.stringify({ event: "agent_api_request_failed", path: url.pathname, message }));
        const status = message.includes("agent token") || message.includes("credential configuration") ? 401 : message.includes("credential scope denied") ? 403 : message.includes("not found") ? 404 : message.includes("mismatch") || message.includes("belongs to") || message.includes("Idempotency payload conflict") ? 409 : 400;
        return json({ error: status === 401 ? "Invalid agent token" : message }, { status });
      }
    }
    if (url.pathname === "/api/sources/collab" && request.method === "POST") {
      try {
        return await handleCollaborationIngest(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "collaboration_ingest_failed", message: redactError(error) }));
        return json({ error: "Collaboration ingest failed" }, { status: 400 });
      }
    }
    if (url.pathname.startsWith("/api/feishu/") || url.pathname === "/api/commands" || url.pathname === "/api/commands/interpret") {
      try {
        return await handleFeishu(request, env, url, ctx);
      } catch (error) {
        const message = redactError(error);
        console.error(JSON.stringify({ event: "max_ops_request_failed", path: url.pathname, message }));
        if (error instanceof IdempotencyPayloadConflictError) return json({ error: message }, { status: 409 });
        const status = /allow(?:ed|list)/i.test(message) ? 403 : 502;
        return json({ error: status === 403 ? "当前飞书账号不在 Demo allowlist" : "OPS 服务暂时不可用" }, { status });
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (env.MAXOPS_ONBOARDING_ONLY === "true") return;
    ctx.waitUntil(recoverDurableWork(env));
  },
};

export default worker;
export { executeCommand };
