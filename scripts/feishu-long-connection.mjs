import * as Lark from "@larksuiteoapi/node-sdk";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CONNECTOR_CONFIG_KEYS = new Set([
  "FEISHU_LONG_CONNECTION_APP_ID",
  "FEISHU_LONG_CONNECTION_APP_SECRET",
  "MAXOPS_FEISHU_CONNECTOR_TOKEN",
  "FEISHU_EVENT_VERIFICATION_TOKEN",
  "MAXOPS_EVENT_URL",
  "MAXOPS_WS_CONFIG_URL",
]);

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function timestamp() {
  return new Date().toISOString();
}

function emit(level, event, details = {}) {
  const line = JSON.stringify({ timestamp: timestamp(), event, ...details });
  const output = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  output(line);
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateConnectorConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Connector config must be a JSON object");
  }

  const normalized = {};
  for (const [key, rawValue] of Object.entries(config)) {
    if (!CONNECTOR_CONFIG_KEYS.has(key)) throw new Error(`Unsupported connector config key: ${key}`);
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      throw new Error(`Connector config value must be a non-empty string: ${key}`);
    }
    normalized[key] = rawValue.trim();
  }

  requiredEnv(normalized, "FEISHU_LONG_CONNECTION_APP_ID");
  if (!normalized.MAXOPS_FEISHU_CONNECTOR_TOKEN && !normalized.FEISHU_EVENT_VERIFICATION_TOKEN) {
    throw new Error("Missing MAXOPS_FEISHU_CONNECTOR_TOKEN or FEISHU_EVENT_VERIFICATION_TOKEN");
  }
  if (!normalized.FEISHU_LONG_CONNECTION_APP_SECRET && !normalized.MAXOPS_FEISHU_CONNECTOR_TOKEN) {
    throw new Error("Missing FEISHU_LONG_CONNECTION_APP_SECRET or MAXOPS_FEISHU_CONNECTOR_TOKEN");
  }
  return normalized;
}

export async function loadPrivateConnectorConfig(configPath) {
  const file = await lstat(configPath);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("Connector config must be a regular file, not a symlink");
  if (file.uid !== process.getuid()) throw new Error("Connector config must be owned by the current user");
  if ((file.mode & 0o077) !== 0) throw new Error("Connector config permissions must be 0600 or stricter");
  if (file.size > 64 * 1024) throw new Error("Connector config is unexpectedly large");
  return validateConnectorConfig(JSON.parse(await readFile(configPath, "utf8")));
}

export function createHealthReporter(healthPath) {
  let state = {};
  let pendingWrite = Promise.resolve();
  return function report(nextState, details = {}) {
    if (!healthPath) return Promise.resolve();
    state = {
      ...state,
      ...details,
      state: nextState,
      pid: process.pid,
      updated_at: timestamp(),
    };
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      const temporaryPath = `${healthPath}.tmp.${process.pid}`;
      await writeFile(temporaryPath, snapshot, { mode: 0o600 });
      await rename(temporaryPath, healthPath);
    });
    return pendingWrite;
  };
}

export function buildFeishuEnvelope(data, verificationToken) {
  return {
    schema: "2.0",
    header: {
      event_id: data.event_id || data.message.message_id,
      event_type: "im.message.receive_v1",
      create_time: data.create_time || data.message.create_time,
      token: verificationToken,
      app_id: data.app_id,
      tenant_key: data.tenant_key,
    },
    event: {
      sender: data.sender,
      message: data.message,
    },
  };
}

export async function forwardFeishuEnvelope({
  envelope,
  eventUrl,
  connectorToken,
  messageId,
  fetchImpl = fetch,
  retryDelays = [250, 1000],
  sleep = delay,
}) {
  let lastError;
  for (let attempt = 1; attempt <= retryDelays.length + 1; attempt += 1) {
    try {
      const response = await fetchImpl(eventUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(connectorToken ? { authorization: `Bearer ${connectorToken}` } : {}),
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (response.ok) {
        emit("info", "maxops_feishu_event_forwarded", {
          event_id: envelope.header.event_id,
          message_id: messageId,
          attempt,
        });
        return { attempt, status: response.status };
      }
      lastError = new Error(`OPS rejected event: HTTP ${response.status}`);
      if (!retryableStatus(response.status)) {
        lastError.retryable = false;
        throw lastError;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown forwarding error");
      if (lastError.retryable === false) throw lastError;
      if (attempt > retryDelays.length) break;
    }
    emit("warn", "maxops_feishu_event_forward_retry", {
      event_id: envelope.header.event_id,
      message_id: messageId,
      attempt,
    });
    await sleep(retryDelays[attempt - 1]);
  }
  throw lastError;
}

export async function startFeishuLongConnection(env = process.env) {
  const appId = requiredEnv(env, "FEISHU_LONG_CONNECTION_APP_ID");
  const appSecret = env.FEISHU_LONG_CONNECTION_APP_SECRET?.trim();
  const connectorToken = env.MAXOPS_FEISHU_CONNECTOR_TOKEN?.trim();
  const verificationToken = env.FEISHU_EVENT_VERIFICATION_TOKEN?.trim();
  if (!connectorToken && !verificationToken) {
    throw new Error("Missing MAXOPS_FEISHU_CONNECTOR_TOKEN or FEISHU_EVENT_VERIFICATION_TOKEN");
  }
  if (!appSecret && !connectorToken) {
    throw new Error("Missing FEISHU_LONG_CONNECTION_APP_SECRET or MAXOPS_FEISHU_CONNECTOR_TOKEN");
  }
  const eventUrl = requiredEnv(env, "MAXOPS_EVENT_URL");
  const wsConfigUrl = env.MAXOPS_WS_CONFIG_URL?.trim();
  if (!appSecret && connectorToken && !wsConfigUrl) {
    throw new Error("Missing MAXOPS_WS_CONFIG_URL when the App Secret is held by the private backend");
  }
  const reportHealth = createHealthReporter(env.MAXOPS_FEISHU_HEALTH_PATH?.trim());
  const safeReportHealth = (state, details) => {
    void reportHealth(state, details).catch((error) => {
      emit("error", "maxops_feishu_health_write_failed", {
        message: error instanceof Error ? error.message : "Unknown health-write error",
      });
    });
  };
  await reportHealth("starting", { started_at: timestamp(), event_url: new URL(eventUrl).origin });

  const httpInstance = !appSecret && connectorToken ? {
    async request() {
      const response = await fetch(wsConfigUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${connectorToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`OPS rejected WS config: HTTP ${response.status}`);
      return response.json();
    },
  } : undefined;

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const envelope = buildFeishuEnvelope(data, verificationToken);
      // Feishu expects the long-connection callback to settle within three
      // seconds. The bridge acknowledges immediately and finishes the heavier
      // AI/status pipeline asynchronously, so do not block the SDK callback.
      void forwardFeishuEnvelope({
        envelope,
        eventUrl,
        connectorToken,
        messageId: data.message.message_id,
      }).then(
        () => safeReportHealth("connected", {
          last_forwarded_at: timestamp(),
          last_error: null,
        }),
        (error) => {
          emit("error", "maxops_feishu_event_forward_failed", {
            event_id: envelope.header.event_id,
            message: error instanceof Error ? error.message : "Unknown forwarding error",
          });
          safeReportHealth("degraded", {
            last_forward_failed_at: timestamp(),
            last_error: error instanceof Error ? error.message : "Unknown forwarding error",
          });
        },
      );
    },
  });

  const wsClient = new Lark.WSClient({
    appId,
    // The SDK validates that one credential field exists before invoking the
    // custom HTTP client. In proxy mode this sentinel never leaves the process;
    // The private backend performs endpoint discovery with the real App Secret.
    appSecret: appSecret || "server-held",
    httpInstance,
    domain: Lark.Domain.Feishu,
    autoReconnect: true,
    source: "max-ops",
    handshakeTimeoutMs: 10_000,
    wsConfig: { pingTimeout: 10 },
    onReady: () => {
      emit("info", "maxops_feishu_connected");
      safeReportHealth("connected", { connected_at: timestamp(), last_error: null });
    },
    onReconnecting: () => {
      emit("warn", "maxops_feishu_reconnecting");
      safeReportHealth("reconnecting", { reconnecting_at: timestamp() });
    },
    onReconnected: () => {
      emit("info", "maxops_feishu_reconnected");
      safeReportHealth("connected", { reconnected_at: timestamp(), last_error: null });
    },
    onError: (error) => {
      emit("error", "maxops_feishu_connection_failed", { message: error.message });
      safeReportHealth("degraded", { last_error: error.message, last_error_at: timestamp() });
    },
  });

  const stop = (signal) => {
    emit("info", "maxops_feishu_stopping", { signal });
    safeReportHealth("stopping", { stopping_at: timestamp(), signal });
    wsClient.close({ force: true });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  await wsClient.start({ eventDispatcher });
  return wsClient;
}

async function runFromProcessEnvironment() {
  const configPath = process.env.MAXOPS_FEISHU_CONNECTOR_CONFIG?.trim();
  const runtimeEnv = configPath
    ? { ...process.env, ...(await loadPrivateConnectorConfig(configPath)) }
    : process.env;
  await startFeishuLongConnection(runtimeEnv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromProcessEnvironment().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    emit("error", "maxops_feishu_start_failed", {
      message,
    });
    const healthPath = process.env.MAXOPS_FEISHU_HEALTH_PATH?.trim();
    if (healthPath) {
      void createHealthReporter(healthPath)("failed", {
        failed_at: timestamp(),
        last_error: message,
      }).catch(() => {});
    }
    process.exitCode = 1;
  });
}
