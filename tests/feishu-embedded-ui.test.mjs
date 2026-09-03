import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, styles, boundary, layout] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(new URL("../app/feishu-embedded.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
]);

test("the primary surface declares an embedded Feishu host, not a standalone entry", () => {
  assert.match(page, /data-host="feishu-embedded"/);
  assert.match(page, /OPS/);
  assert.match(page, /H5 深度总览/);
  assert.match(layout, /在飞书里查看任务、Agent 进度、问题、产物和回执/);
  assert.doesNotMatch(page, /Personal Work OS/);
  assert.doesNotMatch(page, /window\.location\.assign\("\/api\/feishu\/login"\)/);
});

test("preview and FEISHU LIVE are visibly distinct and live is server-confirmed", () => {
  assert.match(page, /data-boundary=\{boundary\.label\}/);
  assert.match(page, /仅改当前预览，不触碰真实飞书/);
  assert.match(boundary, /if \(dataMode === "feishu"\)/);
  assert.match(boundary, /label: "FEISHU LIVE"/);
  assert.match(boundary, /label: "PREVIEW"/);
  assert.match(boundary, /操作只改当前页面，不写真实飞书/);
});

test("state, task writes, and Agent replies use replaceable endpoint constants", () => {
  assert.match(boundary, /state: "\/api\/feishu\/state"/);
  assert.match(boundary, /taskCommand: "\/api\/commands"/);
  assert.match(boundary, /agentInstruction: "\/api\/feishu\/instructions"/);
  assert.match(page, /FEISHU_EMBEDDED_ENDPOINTS\.state/);
  assert.match(page, /FEISHU_EMBEDDED_ENDPOINTS\.taskCommand/);
  assert.match(page, /FEISHU_EMBEDDED_ENDPOINTS\.agentInstruction/);
});

test("unverified native capabilities stay fail-closed while the Base handoff is explicit", () => {
  for (const capability of ["workbenchContext", "interactiveCardAction"]) {
    assert.match(boundary, new RegExp(`${capability}: \\{[\\s\\S]*?status: "zone-a-required"`));
  }
  assert.match(boundary, /openBaseRecord: \{[\s\S]*?status: "h5-self-navigation"/);
  assert.match(boundary, /do not claim Ask AI is embedded/);
});

test("the embedded shell has desktop and narrow-screen layouts", () => {
  assert.match(styles, /\.ops-shell \{ display: grid; grid-template-columns: 78px minmax\(0,1fr\)/);
  assert.match(styles, /\.feishu-rail \{ position: fixed/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.ops-shell \{ display: block; padding-top: 38px; \}/);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*?\.today-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("critical preview actions disclose their boundary", () => {
  assert.match(page, /回复 Agent · \$\{boundary\.actionSuffix\}/);
  assert.match(page, /任务状态操作 · \{boundary\.actionSuffix\}/);
  assert.match(page, /更新预览状态/);
  assert.match(page, /aria-label="关闭"/);
});

test("fresh-copy mode exposes a truthful Ask AI handoff and no second task source", () => {
  assert.match(page, /打开飞书 Base/);
  assert.match(page, /按 ⌘\/Ctrl \+ K 打开同一 Base/);
  assert.match(page, /Base 是唯一真源/);
  assert.match(page, /项目房间只读真实投影/);
  assert.match(page, /window\.location\.assign\(freshBase\.url\)/);
  assert.match(page, /接入你自己的数据与 Agent/);
  assert.match(page, /飞书建好工作台/);
  assert.match(page, /Agent 自动报到/);
  assert.match(page, /当前展示的是脱敏预览/);
  assert.match(page, /页面保持失败关闭，不会用演示数据冒充真实安装/);
  assert.match(page, /不填机器 ID/);
});
