import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FEISHU_AI_STORAGE_KEY,
  buildFeishuAiLauncherUrl,
  loadStoredFeishuBase,
  normalizeFeishuBaseUrl,
  parseFeishuAiHandoff,
} from "../app/feishu-ai-handoff.mjs";

test("a launcher accepts personal and enterprise Feishu Base targets only", () => {
  const baseUrl = "https://my.feishu.cn/base/example?table=tasks";
  const enterpriseUrl = "https://acme.feishu.cn/base/example?table=tasks";
  const launcher = buildFeishuAiLauncherUrl("https://maxi-max-dev.github.io/ops/", baseUrl);
  const parsedLauncher = new URL(launcher);

  assert.equal(parseFeishuAiHandoff(parsedLauncher), baseUrl);
  assert.equal(normalizeFeishuBaseUrl(enterpriseUrl), enterpriseUrl);
  assert.equal(loadStoredFeishuBase({ getItem: (key) => key === FEISHU_AI_STORAGE_KEY ? enterpriseUrl : null }), enterpriseUrl);
  assert.equal(parseFeishuAiHandoff({ hash: "#feishu-ai=https%3A%2F%2Fevil.example%2Fbase%2Fx" }), null);
  assert.equal(normalizeFeishuBaseUrl("https://evilfeishu.cn/base/x"), null);
  assert.equal(parseFeishuAiHandoff({ hash: "#feishu-ai=http%3A%2F%2Fmy.feishu.cn%2Fbase%2Fx" }), null);
  assert.equal(parseFeishuAiHandoff({ hash: "#feishu-ai=https%3A%2F%2Fmy.feishu.cn%2Fdocx%2Fx" }), null);
});

test("invalid or unavailable browser storage fails closed", () => {
  assert.equal(loadStoredFeishuBase({ getItem: () => "javascript:alert(1)" }), null);
  assert.equal(loadStoredFeishuBase({ getItem: () => { throw new Error("blocked"); } }), null);
});

test("the public source keeps the private Base locator out of the repository", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /parseFeishuAiHandoff/);
  assert.match(page, /window\.localStorage\.setItem\(FEISHU_AI_STORAGE_KEY, target\)/);
  assert.match(page, /window\.open\(personalFeishuBaseUrl, "_blank", "noopener,noreferrer"\)/);
  assert.match(page, /接入数据与 Agent/);
  assert.match(page, /这不是数据授权/);
  assert.match(page, /用飞书登录并创建/);
  assert.match(page, /给这个 Agent 起个名字/);
  assert.match(page, /MAXOPS_CONNECTOR_URL/);
  assert.doesNotMatch(page, /飞书已接入/);
  assert.doesNotMatch(page, /TbVJbXWHgaaQrMsQBjlcyQztnoc/);
});
