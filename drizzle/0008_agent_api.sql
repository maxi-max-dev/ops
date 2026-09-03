CREATE TABLE `agent_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`artifact_url` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_events_idempotency_key` ON `agent_events` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_agent_events_run_occurred` ON `agent_events` (`run_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `idx_agent_events_task_occurred` ON `agent_events` (`task_id`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`task_id` text NOT NULL,
	`record_id` text,
	`run_id` text,
	`agent_id` text NOT NULL,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`in_reply_to` text,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`note_marker` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`acknowledged_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_messages_idempotency_key` ON `agent_messages` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_agent_messages_inbox` ON `agent_messages` (`agent_id`,`direction`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_agent_messages_task_created` ON `agent_messages` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `agent_receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_receipts_idempotency_key` ON `agent_receipts` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_agent_receipts_subject_created` ON `agent_receipts` (`subject_type`,`subject_id`,`created_at`);
