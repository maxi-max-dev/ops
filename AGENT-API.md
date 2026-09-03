# OPS Agent API v1

This is the complete integration contract for an Agent. You do not need to read the OPS source code.

The API lets an Agent:

- read one explicitly scoped task from the live Feishu war board without receiving Feishu credentials;
- report run events, blockers, and artifacts to the FEISHU LIVE dashboard;
- ask the operator a task-scoped question;
- poll for the operator's instructions or answers;
- issue delivery/acknowledgement receipts with before/after evidence.

It intentionally does **not** let an Agent mutate a Feishu task status. The user's Feishu board is the source of truth for the five-state task fields. The operator changes those fields in FEISHU LIVE; every write is projected to Feishu with an audit note.

The API is runtime-neutral: `agent_id` is a validated caller-supplied identity, not a Codex allowlist. A complete implementation must still satisfy the identity, capability, task-scope, lifecycle, inbox, acknowledgement, receipt, idempotency, and source-of-truth rules in [ADAPTER-CONTRACT.md](ADAPTER-CONTRACT.md). Accepting an arbitrary string alone is not proof of a complete adapter.

## 1. Connection and authentication

Authorized base URL:

```text
<maxops_url>
```

The public GitHub repository does not select or publish a production endpoint. The workspace owner or invite must provide the exact Agent API URL together with one scoped `record_id`. A static OPS demo is not an Agent API.

Every `/api/agent/v1/*` request requires a Bearer credential. The recommended
credential is pinned by the server to one `agent_id`, one `task_id`, and one
`record_id`. Obtain it and those exact identities from the workspace owner
through a secret channel. Never commit the token, put it in an artifact URL, or
print it in logs.

The Agent API does not accept `MAXOPS_INGEST_TOKEN`. A deployment-wide legacy
token works only when the owner explicitly enables global-token mode, and that
fallback is never attempted when task-scoped credentials are configured.

```bash
export MAXOPS_URL='https://the-authorized-maxops-deployment.example'
read -s MAXOPS_AGENT_TOKEN
export MAXOPS_AGENT_TOKEN
printf '\n'

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${MAXOPS_AGENT_TOKEN}" \
  "${MAXOPS_URL}/api/agent/v1/health"
```

Successful health response:

```json
{"ok":true,"api":"OPS Agent API","version":"v1","credential_mode":"task","server_time":1787731200000}
```

### Read one scoped Feishu task

`GET /api/agent/v1/tasks/<record_id>`

The caller must already know the Base record identity supplied by the operator. This endpoint does not list the board and does not expose raw Feishu fields, notes, or credentials. It returns only the task's project, title, five-state stage, owner, priority, relation, and read timestamp.

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${MAXOPS_AGENT_TOKEN}" \
  "${MAXOPS_URL}/api/agent/v1/tasks/${RECORD_ID}"
```

Use this immediately before starting or resuming a run so the Agent does not operate from a stale prompt copy. A successful read is read-only and creates no task-status event or receipt.

## 2. Idempotency and retry rule

Every mutating request requires an `Idempotency-Key` header:

- 12–200 characters;
- unique for the logical action;
- reused unchanged when retrying that action after a timeout or network failure;
- never reused for a different event, question, message, Agent, or run.

The first accepted request returns HTTP `201`. An identical retry returns HTTP `200`, `"idempotent": true`, and the same durable receipt. OPS stores a normalized payload fingerprint; reusing a key with any different normalized field returns HTTP `409`.

Recommended format:

```text
<agent_id>:<run_id>:<action>:<monotonic-sequence-or-uuid>
```

Requests and responses are JSON. A request body is limited to 16 KiB.

## 3. Report a run event

`POST /api/agent/v1/events`

Required fields:

| Field | Contract |
|---|---|
| `agent_id` | Stable machine-safe Agent identity, max 120 characters. |
| `agent_name` | Human-readable name, max 200 characters. |
| `run_id` | Stable identity for this execution, max 200 characters. |
| `kind` | One of `run_started`, `progress`, `blocked`, `artifact`, `run_finished`, `heartbeat`. |
| `state` | One of `running`, `waiting`, `blocked`, `done`, `failed`. |
| `title` | Short UI label, max 300 characters. |
| `detail` | Evidence or current situation, max 4,000 characters. |
| `task_id` | Required Feishu task identity. OPS rejects an unscoped event and verifies the supplied identity against Feishu. |
| `record_id` | Base record identity returned by the scoped read. Always required, including when it equals `task_id`. |

Optional fields:

| Field | Contract |
|---|---|
| `artifact_url` | An `http://` or `https://` URL. Never put secrets in it. |
| `occurred_at` | Unix time in milliseconds; defaults to server receipt time and cannot be more than five minutes in the future. |

Start a run against the OPS task card:

```bash
export AGENT_ID='codex'
export AGENT_NAME='Codex'
export RUN_ID='codex:example-run-001'
export RECORD_ID='rec_PLACEHOLDER'
export TASK_ID='task_returned_by_scoped_read'

curl --fail-with-body --silent --show-error \
  -X POST "${MAXOPS_URL}/api/agent/v1/events" \
  -H "Authorization: Bearer ${MAXOPS_AGENT_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: ${RUN_ID}:event:001" \
  --data "{\"agent_id\":\"${AGENT_ID}\",\"agent_name\":\"${AGENT_NAME}\",\"run_id\":\"${RUN_ID}\",\"task_id\":\"${TASK_ID}\",\"record_id\":\"${RECORD_ID}\",\"kind\":\"run_started\",\"state\":\"running\",\"title\":\"Agent 已接入\",\"detail\":\"开始执行，并把过程写入 OPS。\"}"
```

Report a blocker:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "${MAXOPS_URL}/api/agent/v1/events" \
  -H "Authorization: Bearer ${MAXOPS_AGENT_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: ${RUN_ID}:event:002" \
  --data "{\"agent_id\":\"${AGENT_ID}\",\"agent_name\":\"${AGENT_NAME}\",\"run_id\":\"${RUN_ID}\",\"task_id\":\"${TASK_ID}\",\"record_id\":\"${RECORD_ID}\",\"kind\":\"blocked\",\"state\":\"blocked\",\"title\":\"等待用户决定\",\"detail\":\"需要用户选择真实数据的处理边界；没有继续写外部状态。\"}"
```

Report an artifact or completion by changing `kind`, `state`, `title`, `detail`, and optionally adding `artifact_url`. The dashboard derives the run's current status from the latest event and renders the latest artifact/blocker evidence.

Event receipt shape:

```json
{
  "ok": true,
  "idempotent": false,
  "event": {
    "event_id": "aevt_...",
    "run_id": "codex:example-run-001",
    "agent_id": "codex",
    "task_id": "task_returned_by_scoped_read",
    "record_id": "rec_PLACEHOLDER",
    "kind": "run_started",
    "state": "running",
    "occurred_at": 1787731200000
  },
  "receipt": {
    "receipt_id": "arct_...",
    "subject_type": "event",
    "subject_id": "aevt_...",
    "agent_id": "codex",
    "kind": "stored",
    "before": {},
    "after": {"stored":true,"event_id":"aevt_...","run_id":"codex:example-run-001","state":"running"},
    "created_at": 1787731200000
  }
}
```

Persist the `receipt_id` in your own run log.

## 4. Ask the operator a question

`POST /api/agent/v1/questions`

Required JSON fields: `agent_id`, `agent_name`, `run_id`, `task_id`, `record_id`, and `question` (max 4,000 characters).

```bash
curl --fail-with-body --silent --show-error \
  -X POST "${MAXOPS_URL}/api/agent/v1/questions" \
  -H "Authorization: Bearer ${MAXOPS_AGENT_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: ${RUN_ID}:question:001" \
  --data "{\"agent_id\":\"${AGENT_ID}\",\"agent_name\":\"${AGENT_NAME}\",\"run_id\":\"${RUN_ID}\",\"task_id\":\"${TASK_ID}\",\"record_id\":\"${RECORD_ID}\",\"question\":\"真实验收完成后，要把任务留在进行中还是改为等外部？\"}"
```

OPS returns a `message.message_id` plus a durable `receipt`. The question appears on the matching task in FEISHU LIVE. When the operator replies there, the original question becomes `answered` and a new `to_agent` answer is queued.

## 5. Poll the Agent inbox

`GET /api/agent/v1/inbox?agent_id=<id>&task_id=<task>&record_id=<record>&run_id=<run>`

`task_id` and `record_id` are required for task-scoped credentials. `run_id` is optional. When present, the response includes messages for that run plus task-scoped instructions whose `run_id` is null.

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${MAXOPS_AGENT_TOKEN}" \
  "${MAXOPS_URL}/api/agent/v1/inbox?agent_id=${AGENT_ID}&task_id=${TASK_ID}&record_id=${RECORD_ID}&run_id=${RUN_ID}"
```

Inbox response:

```json
{
  "ok": true,
  "messages": [
    {
      "message_id": "amsg_...",
      "task_id": "task_returned_by_scoped_read",
      "record_id": "rec_PLACEHOLDER",
      "run_id": "codex:example-run-001",
      "agent_id": "codex",
      "direction": "to_agent",
      "kind": "answer",
      "body": "改为等外部，并留下真实验收证据。",
      "in_reply_to": "amsg_question_...",
      "status": "pending",
      "created_by": "User",
      "created_at": 1787731200000,
      "delivered_at": null,
      "acknowledged_at": null
    }
  ],
  "delivery": "at-least-once; POST a delivered or acknowledged receipt for every message"
}
```

Delivery is **at least once**. Poll on startup, after reporting a blocker/question, and periodically while a run is active. Do not assume an empty poll means the operator will never reply.

## 6. Acknowledge a message

`POST /api/agent/v1/messages/<message_id>/receipts`

Use `kind: "delivered"` once the Agent has durably stored the message, or `kind: "acknowledged"` once the Agent has accepted it into its run. `acknowledged` also sets `delivered_at` if needed.

Copy the returned inbox `message_id` into `MESSAGE_ID`:

```bash
export MESSAGE_ID='amsg_replace_with_real_id'

curl --fail-with-body --silent --show-error \
  -X POST "${MAXOPS_URL}/api/agent/v1/messages/${MESSAGE_ID}/receipts" \
  -H "Authorization: Bearer ${MAXOPS_AGENT_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: ${RUN_ID}:ack:${MESSAGE_ID}" \
  --data "{\"agent_id\":\"${AGENT_ID}\",\"kind\":\"acknowledged\"}"
```

The receipt contains explicit `before` and `after` delivery state. An acknowledged message no longer appears in inbox polling, but remains visible in the OPS audit history.

## 7. Minimal reliable Agent loop

1. Create one stable `run_id` and report `run_started`.
2. Report meaningful `progress`, `artifact`, `blocked`, or `run_finished` events. Reuse the same idempotency key only when retrying the same event.
3. When human input is required, report a `blocked` event and POST one question.
4. Poll the inbox with your `agent_id` and `run_id`.
5. Durably store each message, then POST a `delivered` or `acknowledged` receipt.
6. Apply the operator's instruction inside your own authorization boundary.
7. Report the resulting event. If the instruction requires a Feishu status change, ask the operator to perform/confirm it in FEISHU LIVE; do not invent a second status source.

## 8. HTTP failures

| Status | Meaning / action |
|---|---|
| `200` | Idempotent replay or successful read. |
| `201` | New event, question, instruction, or receipt durably created. |
| `400` | Invalid JSON, field, event kind/state, key, or body size. Fix the request; do not retry unchanged. |
| `401` | Missing/invalid Agent token. Obtain the current token from the operator. |
| `403` | Valid task credential used outside its pinned Agent/task/record scope. Stop; do not broaden or guess the identity. |
| `404` | Route, task, or message not found. Recheck identity. |
| `409` | Idempotency key or reply/message identity mismatch. Stop and use the correct identity; do not generate blind retries. |
| `5xx` or network timeout | Outcome may be unknown. Retry with the **same** idempotency key. |

No HTTP response by itself proves that an Agent acted on an operator instruction. The acknowledgement receipt proves delivery into the Agent run; the Agent's next event/artifact proves what it did.
