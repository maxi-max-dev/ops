# OPS Agent Adapter Contract v1

This contract lets an AI or Agent runtime attach one authorized execution to one OPS task without becoming the Feishu task source of truth. Codex is the first reference adapter, not a platform requirement.

## 1. Identity and task scope

An adapter declares a stable, machine-safe `agent_id` and a human-readable `agent_name`. The API accepts any non-empty identity that satisfies the documented length and string checks; implementations must not assume a Codex allowlist.

Every execution has one stable `run_id` and one explicit task identity supplied by the operator:

- `record_id`: the Feishu Base record identity used for the scoped task read.
- `task_id`: the returned task identity used for events and messages.
- `run_id`: the adapter-owned identity reused for the whole execution.

An adapter must preserve and send both identities for every lifecycle mutation; it must not assume `record_id === task_id`. The server requires both values even when they happen to be equal.
An adapter must never infer a task by title, enumerate the board, or attach unrelated work automatically.
The server rejects every execution event that omits `task_id`; new unscoped runs are not accepted.

The recommended credential is pinned to this `agent_id` + `task_id` +
`record_id` tuple. A scoped credential cannot read another record, post as
another Agent, or poll a cross-task inbox. A deployment may deliberately enable
a legacy global token, but that broader fallback is disabled by default and is
never attempted when a scoped credential set exists.

## 2. Required capabilities

An implementation manifest must declare every operation below and map it to an executable command, method, or endpoint.

| Operation | Required behavior |
|---|---|
| `read` | Read one whitelisted task projection by supplied `record_id`. |
| `start` | Report `run_started` / `running`. |
| `progress` | Report meaningful progress, not presence or an online heartbeat. |
| `blocker` | Report a real blocker with state `blocked`. |
| `question` | Send an operator-facing question tied to the same task and run. |
| `artifact` | Report a real artifact URL with no credentials in it. |
| `finish` | Report `run_finished`; delivery does not substitute for verification. |
| `inbox` | Fetch answers/instructions for the same `agent_id` and `run_id`. |
| `ack` | Mark an accepted inbox message delivered or acknowledged. |
| `receipt` | Preserve the returned receipt identity as communication evidence. |

The current HTTP mapping is documented in [AGENT-API.md](AGENT-API.md). An adapter may use another implementation language as long as its behavior matches this contract.

## 3. Idempotency and retries

Every mutation uses a 12–200 character `Idempotency-Key`. Reuse a key only for the exact same logical action after an unknown network outcome. A new logical action needs a new key. OPS stores a normalized payload fingerprint with the durable row; the same key plus a different payload returns `409`. Missing legacy fingerprints also fail closed instead of being treated as a successful replay.

An adapter must keep one `run_id` for the execution, stop on `400`, `401`, `403`, `404`, or `409`, and retry timeouts or `5xx` responses only with the same idempotency key.

## 4. Source-of-truth boundary

The Agent API records execution and communication evidence. It does **not** directly change the Feishu five-state task fields (`待办 / 进行中 / 等外部 / 完成 / 放弃`). The operator, the OPS UI, or the confirmed Feishu Gate owns those changes. An adapter must not call private Feishu write endpoints, use Base credentials, or describe an event receipt as proof that the task state changed.

## 5. Manifest minimum

`adapter-manifest.json` must include:

- `schema_version`, `adapter_id`, `display_name`, and `reference_runtime`;
- configurable `identity` with `agent_id` and `agent_name`;
- explicit task scope requiring a user-supplied `record_id`;
- all required operations from section 2;
- authentication secret names without secret values;
- idempotency, retry, receipt, and source-of-truth policies;
- a local, non-production `self_check` command.

The reviewed [OPS Agent Connector release](https://github.com/maxi-max-dev/ops/releases/tag/v0.1.0) contains the Codex reference manifest, a zero-dependency CLI, a validator, and a dry-run self-test. A future Agent can generate its own adapter from this contract; passing the validator proves manifest completeness, not a real Feishu end-to-end run.

## 6. Acceptance levels

1. **Manifest-valid:** the contract and local self-check pass.
2. **API-compatible:** the adapter completes the lifecycle against an isolated or authorized API environment.
3. **FEISHU LIVE verified:** the operator observes one continuous real-task chain from Feishu task to Agent events, operator reply, acknowledgement/receipt, and synchronized task overview.

Do not call level 1 or PREVIEW evidence “FEISHU LIVE”.
