import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentPairingInstruction,
  PUBLIC_FEISHU_INSTALLATION,
} from "../app/feishu-onboarding.mjs";

test("the static preview fails closed without a confidential installer", () => {
  assert.equal(PUBLIC_FEISHU_INSTALLATION.status, "permission_gate");
  assert.equal(PUBLIC_FEISHU_INSTALLATION.url, "");
});

test("a novice pairing instruction names the Agent without exposing machine identifiers", () => {
  const instruction = buildAgentPairingInstruction({ agentName: "  Research\nAgent  " });
  assert.match(instruction, /「Research Agent」/);
  assert.match(instruction, /一次性配对链接/);
  assert.match(instruction, /无需向我索取任何技术 ID 或密钥/);
  assert.doesNotMatch(instruction, /app_secret|table_id|message_id|instance_id|task_id|agent_id|run_id/);
});

test("a real pairing link is included only when supplied by the installer", () => {
  const instruction = buildAgentPairingInstruction({ agentName: "Codex", pairingUrl: "https://install.example/pair/once" });
  assert.match(instruction, /https:\/\/install\.example\/pair\/once/);
});
