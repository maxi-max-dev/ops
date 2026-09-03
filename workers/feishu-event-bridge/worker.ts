const EVENT_PATH = "/api/feishu/events";
const MODEL_PATH = "/api/model/resolve";
const MAX_BODY_BYTES = 64 * 1024;

interface BridgeEnv {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  MAXOPS_EVENT_SERVICE?: Fetcher;
  MAXOPS_EVENT_TARGET?: string;
  MAXOPS_ALLOW_HTTP_FALLBACK?: string;
  FEISHU_EVENT_VERIFICATION_TOKEN: string;
  MAXOPS_MODEL_PROXY_TOKEN: string;
}

interface FeishuEnvelope {
  challenge?: unknown;
  header?: { token?: unknown; event_id?: unknown };
  token?: unknown;
  type?: unknown;
  event?: { message?: { message_id?: unknown } };
}

interface ModelRequest {
  input?: unknown;
  instructions?: unknown;
  max_output_tokens?: unknown;
  reasoning?: { effort?: unknown };
  store?: unknown;
  text?: unknown;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function controlledHttpTarget(env: BridgeEnv): string {
  if (env.MAXOPS_ALLOW_HTTP_FALLBACK !== "true" || !env.MAXOPS_EVENT_TARGET) {
    throw new Error("No OPS service binding; HTTP fallback is disabled");
  }
  const target = new URL(env.MAXOPS_EVENT_TARGET);
  if (target.protocol !== "https:" || target.pathname !== EVENT_PATH || target.username || target.password || target.search || target.hash) {
    throw new Error("MAXOPS_EVENT_TARGET must be an exact HTTPS /api/feishu/events endpoint");
  }
  return target.toString();
}

async function readDurableReceipt(response: Response, eventId: string) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OPS rejected event with HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("OPS receipt exceeded the response limit");
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("OPS returned an invalid receipt"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("OPS returned an invalid receipt");
  const result = payload as { ok?: unknown; durable?: unknown; receipt?: { event_id?: unknown; status?: unknown; created_at?: unknown } };
  if (result.ok !== true || result.durable !== true || result.receipt?.event_id !== eventId
    || typeof result.receipt.status !== "string" || typeof result.receipt.created_at !== "number") {
    throw new Error("OPS did not return a matching durable D1 receipt");
  }
  return result.receipt;
}

async function forwardEvent(env: BridgeEnv, body: ArrayBuffer, contentType: string, eventId: string) {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": contentType },
    body,
    redirect: "manual",
  };
  const upstream = env.MAXOPS_EVENT_SERVICE
    ? await env.MAXOPS_EVENT_SERVICE.fetch("https://maxops.internal/api/feishu/events", init)
    : await fetch(controlledHttpTarget(env), init);
  return readDurableReceipt(upstream, eventId);
}

async function resolveModel(request: Request, env: BridgeEnv): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization !== `Bearer ${env.MAXOPS_MODEL_PROXY_TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413);

  let payload: ModelRequest;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as ModelRequest;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (typeof payload.instructions !== "string" || typeof payload.input !== "string") {
    return json({ error: "Invalid model request" }, 400);
  }

  const result = await env.AI.run("@cf/openai/gpt-oss-20b", {
    input: payload.input,
    instructions: payload.instructions,
    max_output_tokens: typeof payload.max_output_tokens === "number" ? payload.max_output_tokens : 300,
    reasoning: { effort: "low" },
    store: false,
    text: payload.text,
  });
  return json(result, 200);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === MODEL_PATH) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return resolveModel(request, env);
    }
    if (url.pathname !== EVENT_PATH) return json({ error: "Not found" }, 404);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return json({ error: "Expected application/json" }, 415);
    }

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return json({ error: "Payload too large" }, 413);
    }

    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413);

    let payload: FeishuEnvelope;
    try {
      payload = JSON.parse(new TextDecoder().decode(body)) as FeishuEnvelope;
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const token = payload.header?.token ?? payload.token;
    if (token !== env.FEISHU_EVENT_VERIFICATION_TOKEN) {
      return json({ error: "Verification failed" }, 401);
    }

    if (payload.type === "url_verification" && typeof payload.challenge === "string") {
      return json({ challenge: payload.challenge }, 200);
    }

    const eventId = typeof payload.header?.event_id === "string" && payload.header.event_id
      ? payload.header.event_id
      : typeof payload.event?.message?.message_id === "string" ? payload.event.message.message_id : "";
    if (!eventId || eventId.length > 200) return json({ error: "Event identity is required" }, 400);
    try {
      const receipt = await forwardEvent(env, body, contentType, eventId);
      return json({ code: 0, durable: true, receipt }, 200);
    } catch (error) {
      console.error(JSON.stringify({
        event: "feishu_event_bridge_failed",
        message: error instanceof Error ? error.message : "Unknown upstream error",
      }));
      return json({ error: "OPS did not durably accept the event" }, 502);
    }
  },
} satisfies ExportedHandler<BridgeEnv>;
