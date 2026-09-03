import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const commands = sqliteTable("commands", {
  commandId: text("command_id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  source: text("source").notNull(),
  sourceEventId: text("source_event_id"),
  actorHash: text("actor_hash").notNull(),
  actorName: text("actor_name"),
  rawInput: text("raw_input").notNull(),
  intent: text("intent"),
  taskId: text("task_id"),
  recordId: text("record_id"),
  targetState: text("target_state"),
  confidence: real("confidence"),
  reason: text("reason"),
  status: text("status").notNull(),
  expectedVersion: integer("expected_version"),
  claimedVersion: integer("claimed_version"),
  runId: text("run_id").notNull(),
  receiptId: text("receipt_id"),
  projectionAppliedAt: integer("projection_applied_at"),
  projectionToken: text("projection_token"),
  projectionLeaseUntil: integer("projection_lease_until"),
  processingToken: text("processing_token"),
  processingLeaseUntil: integer("processing_lease_until"),
  processingStage: text("processing_stage"),
  modelProvider: text("model_provider"),
  modelName: text("model_name"),
  modelResponseId: text("model_response_id"),
  attempts: integer("attempts").notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  confirmedAt: integer("confirmed_at"),
  completedAt: integer("completed_at"),
}, (table) => [
  uniqueIndex("idx_commands_idempotency_key").on(table.idempotencyKey),
  uniqueIndex("idx_commands_source_event_id").on(table.sourceEventId),
  uniqueIndex("idx_commands_run_id").on(table.runId),
  uniqueIndex("idx_commands_receipt_id").on(table.receiptId),
  index("idx_commands_status_created_at").on(table.status, table.createdAt),
]);

export const runs = sqliteTable("runs", {
  runId: text("run_id").primaryKey(),
  commandId: text("command_id").notNull(),
  status: text("status").notNull(),
  provider: text("provider"),
  model: text("model"),
  startedAt: integer("started_at").notNull(),
  completedAt: integer("completed_at"),
}, (table) => [uniqueIndex("idx_runs_command_id").on(table.commandId)]);

export const events = sqliteTable("events", {
  eventId: text("event_id").primaryKey(),
  commandId: text("command_id").notNull(),
  runId: text("run_id").notNull(),
  kind: text("kind").notNull(),
  detailJson: text("detail_json").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("idx_events_command_created_at").on(table.commandId, table.createdAt)]);

export const gates = sqliteTable("gates", {
  gateId: text("gate_id").primaryKey(),
  commandId: text("command_id").notNull(),
  status: text("status").notNull(),
  beforeJson: text("before_json").notNull(),
  afterJson: text("after_json").notNull(),
  requestedAt: integer("requested_at").notNull(),
  decidedAt: integer("decided_at"),
  decidedByHash: text("decided_by_hash"),
}, (table) => [uniqueIndex("idx_gates_command_id").on(table.commandId)]);

export const taskEntities = sqliteTable("task_entities", {
  taskId: text("task_id").primaryKey(),
  recordId: text("record_id").notNull(),
  state: integer("state").notNull(),
  stage: text("stage").notNull().default("open"),
  version: integer("version").notNull(),
  causationId: text("causation_id"),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [uniqueIndex("idx_task_entities_record_id").on(table.recordId)]);

export const receipts = sqliteTable("receipts", {
  receiptId: text("receipt_id").primaryKey(),
  commandId: text("command_id").notNull(),
  runId: text("run_id").notNull(),
  status: text("status").notNull(),
  taskId: text("task_id").notNull(),
  entityVersion: integer("entity_version").notNull(),
  beforeJson: text("before_json").notNull(),
  afterJson: text("after_json").notNull(),
  notificationStatus: text("notification_status").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_receipts_command_id").on(table.commandId),
  uniqueIndex("idx_receipts_run_id").on(table.runId),
]);

export const notificationOutbox = sqliteTable("notification_outbox", {
  notificationId: text("notification_id").primaryKey(),
  commandId: text("command_id").notNull(),
  runId: text("run_id").notNull(),
  kind: text("kind").notNull(),
  recipientCiphertext: text("recipient_ciphertext").notNull(),
  bodyText: text("body_text").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  leaseUntil: integer("lease_until"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_notification_command_kind").on(table.commandId, table.kind),
  index("idx_notification_status_updated").on(table.status, table.updatedAt),
]);

export const sourceEvents = sqliteTable("source_events", {
  sourceEventId: text("source_event_id").primaryKey(),
  source: text("source").notNull(),
  occurredAt: integer("occurred_at").notNull(),
  actor: text("actor").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  detail: text("detail").notNull(),
  sourcePath: text("source_path").notNull(),
  sourceHash: text("source_hash").notNull(),
  taskId: text("task_id"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_source_events_source_hash").on(table.source, table.sourceHash),
  index("idx_source_events_occurred_at").on(table.occurredAt),
]);

export const agentEvents = sqliteTable("agent_events", {
  eventId: text("event_id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  runId: text("run_id").notNull(),
  agentId: text("agent_id").notNull(),
  agentName: text("agent_name").notNull(),
  taskId: text("task_id"),
  recordId: text("record_id"),
  payloadFingerprint: text("payload_fingerprint"),
  kind: text("kind").notNull(),
  state: text("state").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  artifactUrl: text("artifact_url"),
  occurredAt: integer("occurred_at").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_agent_events_idempotency_key").on(table.idempotencyKey),
  index("idx_agent_events_run_occurred").on(table.runId, table.occurredAt),
  index("idx_agent_events_task_occurred").on(table.taskId, table.occurredAt),
  index("idx_agent_events_record_occurred").on(table.recordId, table.occurredAt),
]);

export const agentMessages = sqliteTable("agent_messages", {
  messageId: text("message_id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  taskId: text("task_id").notNull(),
  recordId: text("record_id"),
  runId: text("run_id"),
  agentId: text("agent_id").notNull(),
  direction: text("direction").notNull(),
  kind: text("kind").notNull(),
  body: text("body").notNull(),
  inReplyTo: text("in_reply_to"),
  status: text("status").notNull(),
  createdBy: text("created_by").notNull(),
  noteMarker: text("note_marker"),
  payloadFingerprint: text("payload_fingerprint"),
  createdAt: integer("created_at").notNull(),
  deliveredAt: integer("delivered_at"),
  acknowledgedAt: integer("acknowledged_at"),
}, (table) => [
  uniqueIndex("idx_agent_messages_idempotency_key").on(table.idempotencyKey),
  index("idx_agent_messages_inbox").on(table.agentId, table.direction, table.status, table.createdAt),
  index("idx_agent_messages_task_created").on(table.taskId, table.createdAt),
]);

export const agentReceipts = sqliteTable("agent_receipts", {
  receiptId: text("receipt_id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull(),
  beforeJson: text("before_json").notNull(),
  afterJson: text("after_json").notNull(),
  payloadFingerprint: text("payload_fingerprint"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_agent_receipts_idempotency_key").on(table.idempotencyKey),
  index("idx_agent_receipts_subject_created").on(table.subjectType, table.subjectId, table.createdAt),
]);

export const feishuEventReceipts = sqliteTable("feishu_event_receipts", {
  eventId: text("event_id").primaryKey(),
  payloadFingerprint: text("payload_fingerprint").notNull(),
  eventType: text("event_type").notNull(),
  messageId: text("message_id"),
  status: text("status").notNull(),
  commandId: text("command_id").references(() => commands.commandId),
  runId: text("run_id"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_feishu_event_receipts_created").on(table.createdAt),
]);

// The onboarding ledger stores only OAuth/Base locators, pairing state, and
// revocation metadata. Project, task, event, feedback, and receipt content
// remains exclusively in each user's Feishu Base.
export const onboardingWorkspaces = sqliteTable("onboarding_workspaces", {
  workspaceId: text("workspace_id").primaryKey(),
  ownerHash: text("owner_hash").notNull(),
  tenantHash: text("tenant_hash").notNull(),
  displayName: text("display_name").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  tokenExpiresAt: integer("token_expires_at").notNull(),
  refreshExpiresAt: integer("refresh_expires_at").notNull(),
  revokedAt: integer("revoked_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_onboarding_owner_active").on(table.ownerHash).where(sql`${table.revokedAt} IS NULL`),
  index("idx_onboarding_tenant_created").on(table.tenantHash, table.createdAt),
]);

export const onboardingPairCodes = sqliteTable("onboarding_pair_codes", {
  codeHash: text("code_hash").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => onboardingWorkspaces.workspaceId),
  agentName: text("agent_name").notNull(),
  taskId: text("task_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("idx_onboarding_pair_workspace").on(table.workspaceId, table.createdAt)]);

export const onboardingAgentCredentials = sqliteTable("onboarding_agent_credentials", {
  credentialHash: text("credential_hash").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => onboardingWorkspaces.workspaceId),
  agentId: text("agent_id").notNull(),
  agentName: text("agent_name").notNull(),
  taskId: text("task_id").notNull(),
  revokedAt: integer("revoked_at"),
  lastSeenAt: integer("last_seen_at"),
  firstReceiptId: text("first_receipt_id"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_onboarding_agent_id").on(table.agentId),
  index("idx_onboarding_agent_workspace").on(table.workspaceId, table.createdAt),
]);
