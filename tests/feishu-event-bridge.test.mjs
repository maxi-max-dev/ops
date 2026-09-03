import assert from "node:assert/strict";
import test from "node:test";
import bridge from "../workers/feishu-event-bridge/worker.ts";

const envelope = {
  header: { token: "event-token", event_id: "evt-bridge-1", event_type: "im.message.receive_v1" },
  event: { message: { message_id: "msg-bridge-1" } },
};

function request(payload = envelope) {
  return new Request("https://bridge.test/api/feishu/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function baseEnv(overrides = {}) {
  return {
    AI: { run: async () => ({}) },
    FEISHU_EVENT_VERIFICATION_TOKEN: "event-token",
    MAXOPS_MODEL_PROXY_TOKEN: "model-token",
    ...overrides,
  };
}

test("bridge awaits a service binding and ACKs only its matching durable D1 receipt", async () => {
  let release;
  let settled = false;
  const responsePromise = bridge.fetch(request(), baseEnv({
    MAXOPS_EVENT_SERVICE: {
      fetch: async () => new Promise((resolve) => {
        release = () => resolve(Response.json({
          ok: true,
          durable: true,
          receipt: { event_id: "evt-bridge-1", status: "accepted", created_at: 1788000000000 },
        }, { status: 202 }));
      }),
    },
  }), {}).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).durable, true);
});

test("bridge refuses fake ACKs and disabled HTTP fallback", async () => {
  const nondurable = await bridge.fetch(request(), baseEnv({
    MAXOPS_EVENT_SERVICE: { fetch: async () => Response.json({ ok: true }, { status: 202 }) },
  }), {});
  assert.equal(nondurable.status, 502);

  const disabled = await bridge.fetch(request(), baseEnv({
    MAXOPS_EVENT_TARGET: "https://example.test/api/feishu/events",
    MAXOPS_ALLOW_HTTP_FALLBACK: "false",
  }), {});
  assert.equal(disabled.status, 502);
});

test("URL verification remains local and does not call the downstream binding", async () => {
  let calls = 0;
  const response = await bridge.fetch(request({ type: "url_verification", token: "event-token", challenge: "challenge-value" }), baseEnv({
    MAXOPS_EVENT_SERVICE: { fetch: async () => { calls += 1; return new Response(); } },
  }), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: "challenge-value" });
  assert.equal(calls, 0);
});
