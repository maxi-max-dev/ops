# OPS — Feishu Agent Mission Control

A personal mission-control dashboard whose default shareable UI is the static GitHub Pages build. Feishu Base remains the only live task source, while the public build uses labelled synthetic data and can run without a server. OPS is the current contest working name; the production/UI name remains OPS.

[Open the public evaluator preview](https://maxi-max-dev.github.io/ops/)

Private Feishu-native and H5 canaries are intentionally excluded from the public submission.

## Runtime boundaries

- **GitHub Pages default**: anonymous, host-free-at-runtime static demo with 今天 / 项目 / 动态, project deep dive, and browser-local Preview interactions
- **Feishu-native live source**: Base application mode reads the same Judge Copy and provides 今天 / 项目详情 / 项目 / 任务 / 动态 / 问题与反馈 / 产物与回执 without an external host
- Mission star map and project cockpit
- **Private H5 fallback / `FEISHU LIVE`**: authenticated Feishu Base data, its real five task states, persistent D1 command/run/event/gate/receipt ledger, arbitrary Agent events/blockers/artifacts, task-scoped questions/instructions, and audited Feishu/H5 receipts
- **GitHub Pages / `STATIC DEMO`**: browser-local synthetic data and simulated Agent interactions only; it is not evidence of the live loop
- Press `A` to open the AI command panel. It needs `OPENAI_API_KEY`; when that key is absent, the direct five-state and Agent-instruction paths remain available and the AI path fails closed.

The owner-only production runtime uses Feishu OAuth, an actor-hash allowlist, D1, and a read-only five-table projection. Optional model and bot-event paths fail closed when their own secrets are absent; they never report simulated success.

A same-tenant canary proved that Base application mode opens directly in Feishu Web. The project owner subsequently chose the better-looking GitHub build as the default shareable experience; the Base app remains a private live source. The old web app still routes through AppLink and remains a fallback only. See [`FEISHU-NATIVE-APP.md`](./FEISHU-NATIVE-APP.md) for the private canary and [`GITHUB-STATIC-AI-HANDOFF.md`](./GITHUB-STATIC-AI-HANDOFF.md) for the current public boundary.

## Feishu boundary

The public site never receives Base data without a valid Feishu OAuth session. The Worker owns all credentials, pins API access to one Base and one table, verifies actor hashes and task identity, and returns command/run/receipt IDs. Required runtime variables are stored in the hosting environment, never in source:

- `FEISHU_H5_APP_ID`, `FEISHU_H5_APP_SECRET`
- `FEISHU_SERVICE_APP_ID`, `FEISHU_SERVICE_APP_SECRET`
- `MAXOPS_FRESH_BASE_APP_TOKEN`, `MAXOPS_FRESH_BASE_URL` — read-only five-table Base projection used by the deployed `FEISHU LIVE` path
- `FEISHU_BASE_APP_TOKEN`, `FEISHU_TABLE_ID`
- `FEISHU_TASK_SCHEMA=war_board` — use the original `🧭作战板` fields (`阶段`, `谁在干`, `下一步`, `备注`) and its five states, including `🛑放弃`; omit it for the legacy `完成` boolean table
- `FEISHU_EVENT_VERIFICATION_TOKEN`
- `FEISHU_ALLOWED_OPEN_ID_HASHES` — comma-separated SHA-256 hashes; obtain the signed-in user's hash from `/api/feishu/whoami`, never store the raw `open_id`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` — optional; defaults to `gpt-5-mini`
- `MAXOPS_INGEST_TOKEN` — a separate long random secret used only by the local collaboration-board adapter
- `MAXOPS_AGENT_TASK_CREDENTIALS_JSON` — secret JSON array of task-scoped Agent credentials. Each entry stores only `token_sha256`, `agent_id`, `task_id`, and `record_id`; all four scopes must match.
- `MAXOPS_AGENT_TOKEN` + `MAXOPS_AGENT_ALLOW_GLOBAL_TOKEN=true` — explicit legacy global-token mode. It is disabled by default and is never used when task-scoped credentials are configured.

`MAXOPS_INGEST_TOKEN` is never an Agent API fallback. A missing, empty, malformed,
or non-matching task credential fails closed. Agent mutations require both
`task_id` and `record_id`; OPS verifies that pair against the live Base
record and stores both identities in D1.

Provision scoped credentials as a hosting secret; never put a raw token or its
hash in `wrangler.jsonc`:

```json
[
  {
    "token_sha256": "<43-character base64url SHA-256>",
    "agent_id": "<stable-agent-id>",
    "task_id": "<logical-task-id>",
    "record_id": "<feishu-base-record-id>"
  }
]
```

The JSON is strict: an empty list, malformed entry, duplicate token hash, or
out-of-scope request rejects authentication. Rotate the raw Bearer token by
replacing its hash; do not keep the old and new token under the same scope
longer than the handover requires.

Enable only the single-chat bot scopes needed to receive and send text messages. The private runtime must inject its D1-compatible database binding as `DB`; no runtime secrets or bindings belong in GitHub Pages.

For Feishu tenants that cannot reach the private runtime callback reliably, use the
official long-connection mode. It receives `im.message.receive_v1` through
Feishu's Node SDK and forwards the original identity and message into the same
audited `/api/feishu/events` path:

```bash
FEISHU_LONG_CONNECTION_APP_ID=cli_xxx \
MAXOPS_FEISHU_CONNECTOR_TOKEN=xxx \
MAXOPS_EVENT_URL=https://ops-runtime.example/api/feishu/events \
npm run feishu:connect
```

These credentials belong in the runtime secret manager, not a committed `.env`
file. In this mode the private OPS backend keeps the Feishu App Secret and returns only
a short-lived WebSocket configuration to the authenticated connector. The HTTP
callback Worker in `workers/feishu-event-bridge/` remains a small alternative
for networks that can reach a Cloudflare Worker directly. It prefers a service
binding and returns Feishu's success ACK only after OPS returns a matching
durable D1 event receipt. A failed or malformed downstream response returns
`502` so Feishu can retry with the same event identity.

### Keep the long connection running on macOS

The connector includes a launchd service manager with automatic startup,
restart-on-exit, private config validation, structured logs, and a health file.
It never puts the connector token in the plist, argv, repository, or command
output.

First pass the JSON config through stdin. The file is atomically written under
`~/Library/Application Support/MAX OPS/` with mode `0600`. This directory name
is retained for compatibility; the product display name is OPS.

```bash
pbpaste | npm run feishu:service -- configure
npm run feishu:service -- install
```

The clipboard JSON must contain `FEISHU_LONG_CONNECTION_APP_ID`,
`MAXOPS_FEISHU_CONNECTOR_TOKEN`, and `MAXOPS_EVENT_URL`; optional WebSocket and
verification-token fields use the names documented above. Do not paste the JSON after the command as
an argument, and clear the clipboard after configuration. A password-manager
CLI can be piped into the same command instead. Useful operations:

```bash
npm run feishu:service -- status
npm run feishu:service -- doctor
npm run feishu:service -- restart
npm run feishu:service -- uninstall
```

Uninstalling preserves the private config unless `--remove-config` is supplied.
Logs live under `~/Library/Logs/OPS/`. A failed long-connection forward is retried
twice with bounded backoff; the backend/D1 idempotency key makes a duplicate retry
safe.

## Two-source model

OPS is a projection over two sources, not a replacement database:

- Feishu `🧭作战板` owns human-maintained task state.
- Local `🚀项目/_跨助手协作板.md` owns cross-agent handoffs and work evidence.
- D1 stores commands, receipts and idempotent source events so the UI can merge both without one silently overwriting the other.

Preview the local adapter without sending anything:

```bash
npm run sync:collab -- --dry-run
```

To ingest the current section, set `MAXOPS_URL` and the same `MAXOPS_INGEST_TOKEN` configured on the Worker, then run `npm run sync:collab`. Repeated runs are safe: each collaboration-board line is keyed by its SHA-256 hash.

## Agent integration

See [`AGENT-API.md`](./AGENT-API.md) for the self-contained v1 HTTP contract and copy/paste `curl` sequence. The Agent API deliberately cannot edit Feishu task status; that field remains owned by the user's Feishu task source.

## Run locally

Requires Node.js `>=22.13.0`.

```bash
npm ci
npm run dev
```

Then open the local URL printed in the terminal, normally `http://localhost:3000`.

## Verify

```bash
npm test
npm run lint
npm run build
npm run build:pages
```

## Public evaluator preview

The only public preview is GitHub Pages:

`https://maxi-max-dev.github.io/ops/`

`npm run build:pages` produces the static artifact published from this repository. It deliberately runs with labelled demo data and contains no Feishu credentials, Base records, D1 data, or Connector secrets. Private runtime configuration and live Base data remain outside this repository.

The public page includes a truthful `接入数据与 Agent` onboarding action. Its novice target is two steps: sign in with Feishu so an OPS Base workspace is provisioned in the user's tenant, then name an Agent and send it one scoped pairing instruction. Users never type internal message/task/run IDs. The Beta Worker now implements OAuth, five-table provisioning and rediscovery, same-Base dashboard reads/writes, one-time Connector v2 pairing, progress receipts, and immediate revocation. This cross-tenant path still requires a non-public Feishu Store App and a confidential OAuth callback, so the current public UI fails closed while those pieces are unpublished. The reviewed [OPS Agent Connector package](https://github.com/maxi-max-dev/ops/releases/download/v0.1.0/max-ops-agent-connector-2.1.0.tgz) is attached to this clean repository's release. A zero-hosting fallback—copy the five-table Base, create a self-built Feishu app, keep its secret locally, and install the Connector—is retained as an advanced technical route, not presented as novice onboarding. See [`docs/feishu-onboarding-contract.json`](./docs/feishu-onboarding-contract.json) and [`docs/ONE-CLICK-BETA.md`](./docs/ONE-CLICK-BETA.md).

A user may still paste their own `https://example.feishu.cn/base/BASE_TOKEN` URL as an optional browser-local shortcut. The address is validated and stored only on that browser; this convenience does not grant data access or connect an Agent. `Command/Ctrl + K` opens that Base after the shortcut is saved. An owner-only launcher can supply the same target through an allowlisted URL fragment. The Base AI panel itself is not deep-linkable, so the user still clicks `问问 AI` inside Feishu.

`npm test` includes in-memory SQLite migrations, Feishu-source stale-write rejection, projection crash recovery, service-binding ACK fencing, task-scoped credential denial, payload-conflict detection, and a complete Agent event → question → user reply → inbox acknowledgement loop.

## Main files

- `app/page.tsx` — dashboard state and interactions
- `app/globals.css` — visual system and responsive layout
- `app/agent-loop.mjs` — static-demo-only simulated transitions
- `app/voice-command.mjs` — static-demo-only parsing helpers
- `worker/command-core.mjs` — exact Gate protocol and model decision normalization
- `worker/index.ts` — Feishu OAuth/webhook, model call, D1 ledger, Gate, Base projection, receipts, and app routing
- `worker/onboarding.ts` — one-click Store App OAuth, user-owned Base binding, pairing, Connector receipt and revocation boundary
- `worker/onboarding-contract.mjs` — sanitized five-table portable template and fidelity checks
- `ADAPTER-CONTRACT.md` — open Agent adapter contract; Codex is the first reference adapter, not an API allowlist
- `scripts/feishu-long-connection.mjs` — official Feishu SDK receiver for private-message events
- `db/schema.ts` and `drizzle/` — durable ledger schema and migrations

Built with React 19 and [vinext](https://github.com/cloudflare/vinext); the public evaluator preview is published only through GitHub Pages.
