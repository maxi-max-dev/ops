import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildFeishuEnvelope,
  createHealthReporter,
  forwardFeishuEnvelope,
  loadPrivateConnectorConfig,
  validateConnectorConfig,
} from "../scripts/feishu-long-connection.mjs";
import {
  configure,
  renderLaunchAgentPlist,
  servicePaths,
} from "../scripts/manage-feishu-long-connection.mjs";

test("long-connection messages preserve Feishu identity and task content", () => {
  const data = {
    event_id: "evt-1",
    app_id: "cli-test",
    tenant_key: "tenant-1",
    create_time: "1720000000000",
    sender: { sender_id: { open_id: "ou-max" }, sender_type: "user" },
    message: {
      message_id: "msg-1",
      create_time: "1720000000000",
      chat_id: "oc-chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "把黑客松 Demo 改成进行中" }),
    },
  };

  assert.deepEqual(buildFeishuEnvelope(data, "verification-token"), {
    schema: "2.0",
    header: {
      event_id: "evt-1",
      event_type: "im.message.receive_v1",
      create_time: "1720000000000",
      token: "verification-token",
      app_id: "cli-test",
      tenant_key: "tenant-1",
    },
    event: { sender: data.sender, message: data.message },
  });
});

test("message id is the idempotency fallback when Feishu omits event id", () => {
  const data = {
    sender: { sender_id: { open_id: "ou-max" }, sender_type: "user" },
    message: {
      message_id: "msg-fallback",
      create_time: "1720000000001",
      chat_id: "oc-chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "完成 Demo" }),
    },
  };

  assert.equal(buildFeishuEnvelope(data, "verification-token").header.event_id, "msg-fallback");
});

test("connector config accepts the token proxy mode and rejects unknown fields", () => {
  assert.deepEqual(validateConnectorConfig({
    FEISHU_LONG_CONNECTION_APP_ID: "cli-test",
    MAXOPS_FEISHU_CONNECTOR_TOKEN: "connector-test",
  }), {
    FEISHU_LONG_CONNECTION_APP_ID: "cli-test",
    MAXOPS_FEISHU_CONNECTOR_TOKEN: "connector-test",
  });
  assert.throws(() => validateConnectorConfig({
    FEISHU_LONG_CONNECTION_APP_ID: "cli-test",
    MAXOPS_FEISHU_CONNECTOR_TOKEN: "connector-test",
    SURPRISE_SECRET: "must-not-pass",
  }), /Unsupported connector config key/);
});

test("private connector loader rejects group-readable credential files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maxops-config-"));
  const configPath = join(directory, "connector.json");
  const config = JSON.stringify({
    FEISHU_LONG_CONNECTION_APP_ID: "cli-test",
    MAXOPS_FEISHU_CONNECTOR_TOKEN: "connector-test",
  });
  try {
    await writeFile(configPath, config, { mode: 0o640 });
    await assert.rejects(() => loadPrivateConnectorConfig(configPath), /permissions must be 0600/);
    await chmod(configPath, 0o600);
    assert.equal((await loadPrivateConnectorConfig(configPath)).FEISHU_LONG_CONNECTION_APP_ID, "cli-test");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("service configuration is atomically stored with private permissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "maxops-private-home-"));
  const paths = servicePaths({ home, projectRoot: join(home, "project") });
  try {
    await configure(paths, JSON.stringify({
      FEISHU_LONG_CONNECTION_APP_ID: "cli-test",
      MAXOPS_FEISHU_CONNECTOR_TOKEN: "connector-test",
    }));
    assert.equal((await stat(paths.supportDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.configPath)).mode & 0o777, 0o600);
    assert.equal((await loadPrivateConnectorConfig(paths.configPath)).MAXOPS_FEISHU_CONNECTOR_TOKEN, "connector-test");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent health updates serialize and leave the newest complete snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maxops-health-"));
  const healthPath = join(directory, "health.json");
  try {
    const report = createHealthReporter(healthPath);
    await Promise.all([
      report("starting", { started_at: "first" }),
      report("connected", { connected_at: "second" }),
    ]);
    const health = JSON.parse(await readFile(healthPath, "utf8"));
    assert.equal(health.state, "connected");
    assert.equal(health.started_at, "first");
    assert.equal(health.connected_at, "second");
    assert.equal((await stat(healthPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("event forwarding retries transient failures but not permanent rejection", async () => {
  const envelope = { header: { event_id: "evt-retry" } };
  const statuses = [503, 202];
  const sleeps = [];
  const result = await forwardFeishuEnvelope({
    envelope,
    eventUrl: "https://example.test/api/feishu/events",
    connectorToken: "token-test",
    messageId: "msg-retry",
    fetchImpl: async () => new Response(null, { status: statuses.shift() }),
    retryDelays: [5],
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.deepEqual(result, { attempt: 2, status: 202 });
  assert.deepEqual(sleeps, [5]);

  let attempts = 0;
  await assert.rejects(() => forwardFeishuEnvelope({
    envelope,
    eventUrl: "https://example.test/api/feishu/events",
    connectorToken: "token-test",
    messageId: "msg-rejected",
    fetchImpl: async () => {
      attempts += 1;
      return new Response(null, { status: 401 });
    },
    retryDelays: [1, 1],
    sleep: async () => {},
  }), /HTTP 401/);
  assert.equal(attempts, 1);
});

test("launch agent points to a private config path and contains no credential values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maxops-plist-"));
  const home = join(directory, "maxops-home & test");
  const projectRoot = join(directory, "maxops-project");
  const plistPath = join(directory, "connector.plist");
  try {
    const paths = servicePaths({ home, projectRoot });
    await mkdir(projectRoot, { recursive: true });
    const plist = renderLaunchAgentPlist({ paths, nodePath: "/opt/homebrew/bin/node" });
    assert.match(plist, /com\.max\.maxops-feishu-long-connection/);
    assert.match(plist, /MAXOPS_FEISHU_CONNECTOR_CONFIG/);
    assert.match(plist, /maxops-home &amp; test/);
    assert.doesNotMatch(plist, /connector-test|FEISHU_LONG_CONNECTION_APP_SECRET/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    await writeFile(plistPath, plist);
    if (process.platform === "darwin") {
      assert.doesNotThrow(() => execFileSync("/usr/bin/plutil", ["-lint", plistPath], { stdio: "pipe" }));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
