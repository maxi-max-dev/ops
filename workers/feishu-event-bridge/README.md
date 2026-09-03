# Feishu event bridge

This Worker exposes one fixed `POST /api/feishu/events` route. It verifies
Feishu's token and returns URL-verification challenges immediately. Normal
events are forwarded synchronously to the private OPS backend. The bridge
awaits the call and acknowledges Feishu only after OPS returns a matching
durable D1 event receipt. A timeout, upstream error, mismatched identity, or
response without `durable: true` returns `502`; it is never converted into a
false success ACK.

The secret `FEISHU_EVENT_VERIFICATION_TOKEN` must match the token configured in
Feishu and the OPS backend. It is stored with `wrangler secret put`, never in this
repository. The bridge has no storage, task logic, or open-proxy behavior.
OPS remains responsible for AI routing, Base writeback, idempotency, and
receipts.

Prefer a service binding named `MAXOPS_EVENT_SERVICE`; service-binding calls
are always awaited. The binding must target the OPS Worker that owns D1.
The checked-in config intentionally leaves the binding target unspecified so a
repository clone cannot guess a production service name.

An HTTPS fallback exists only for controlled migrations. It requires both an
exact `https://.../api/feishu/events` value in `MAXOPS_EVENT_TARGET` (with no
credentials, query, or fragment) and `MAXOPS_ALLOW_HTTP_FALLBACK=true`.
Fallback is checked in as `false`. Enable it deliberately in the target
environment only after verifying the endpoint; a missing service binding does
not silently activate it.

The deployment owner can add the binding without committing a real service ID:

```jsonc
"services": [
  { "binding": "MAXOPS_EVENT_SERVICE", "service": "<authorized-max-ops-worker>" }
]
```

`POST /api/model/resolve` is a separate Bearer-protected route backed by a
Workers AI binding. It only resolves structured task intent; it cannot read or
write Feishu Base. Its `MAXOPS_MODEL_PROXY_TOKEN` is also stored as a Wrangler
secret. The deployment uses the lower-latency `@cf/openai/gpt-oss-20b` model
with low reasoning effort; OPS still validates the schema before any Gate.
