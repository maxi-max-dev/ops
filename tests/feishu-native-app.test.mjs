import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contractUrl = new URL(
  "../docs/feishu-native-app-contract.json",
  import.meta.url,
);

test("Feishu native app contract keeps Base as the only task source", async () => {
  const contract = JSON.parse(await readFile(contractUrl, "utf8"));

  assert.equal(contract.decision, "base_application_mode");
  assert.equal(contract.source_of_truth, "feishu_base_only");
  assert.equal(contract.external_h5_role, "fallback_only");
  assert.equal(contract.native_app_url, "https://example.feishu.cn/app/APP_ID");
  assert.equal(contract.source_base_url, "https://example.feishu.cn/base/BASE_TOKEN");
  assert.doesNotMatch(JSON.stringify(contract), /my\.feishu\.cn|cli_[A-Za-z0-9]{10,}/);
});

test("native app handoff records every unclosed canary honestly", async () => {
  const contract = JSON.parse(await readFile(contractUrl, "utf8"));

  assert.equal(contract.canaries.same_tenant_same_base, "pass");
  assert.equal(contract.canaries.project_deep_dive, "pass");
  assert.equal(contract.canaries.base_ask_ai, "pass");
  assert.equal(contract.canaries.connector_continuity, "pass");
  assert.equal(contract.canaries.app_to_ask_ai_button, "fail_removed");
  assert.equal(contract.canaries.mobile_device, "unavailable");
  assert.equal(contract.canaries.mainland_network, "unavailable");
  assert.equal(
    contract.canaries.anonymous_judge_access,
    "blocked_by_approval",
  );
});

test("private live judge path stays within three main actions", async () => {
  const contract = JSON.parse(await readFile(contractUrl, "utf8"));

  assert.ok(contract.judge_path_max_private_live.length <= 3);
  assert.ok(contract.pages.includes("今天"));
  assert.ok(contract.pages.includes("项目详情"));
  assert.ok(contract.pages.includes("动态"));
});

test("native v2 keeps the judge overview human-readable", async () => {
  const contract = JSON.parse(await readFile(contractUrl, "utf8"));

  assert.equal(contract.visual_revision, "native-v2");
  assert.equal(contract.theme, "feishu-yunlan-light");
  assert.equal(contract.today_overview.machine_ids_visible, false);
  assert.equal(contract.today_overview.flight_strip.length, 4);
  assert.equal(contract.project_detail.task_count, 2);
  assert.equal(contract.project_detail.agent_event_count, 6);
  assert.equal(contract.project_detail.machine_ids_visible, false);
  assert.equal(contract.preferred_desktop_evidence.length, 2);
});
