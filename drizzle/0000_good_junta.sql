CREATE TABLE `commands` (
	`command_id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`source` text NOT NULL,
	`source_event_id` text,
	`actor_hash` text NOT NULL,
	`actor_name` text,
	`raw_input` text NOT NULL,
	`intent` text,
	`task_id` text,
	`record_id` text,
	`target_state` text,
	`confidence` real,
	`reason` text,
	`status` text NOT NULL,
	`expected_version` integer,
	`claimed_version` integer,
	`run_id` text NOT NULL,
	`model_provider` text,
	`model_name` text,
	`model_response_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`confirmed_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_commands_idempotency_key` ON `commands` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_commands_source_event_id` ON `commands` (`source_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_commands_run_id` ON `commands` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_commands_status_created_at` ON `commands` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_command_created_at` ON `events` (`command_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `gates` (
	`gate_id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`status` text NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gates_command_id` ON `gates` (`command_id`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`task_id` text NOT NULL,
	`entity_version` integer NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`notification_status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_receipts_command_id` ON `receipts` (`command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_receipts_run_id` ON `receipts` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`status` text NOT NULL,
	`provider` text,
	`model` text,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_runs_command_id` ON `runs` (`command_id`);--> statement-breakpoint
CREATE TABLE `task_entities` (
	`task_id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`state` integer NOT NULL,
	`version` integer NOT NULL,
	`causation_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_entities_record_id` ON `task_entities` (`record_id`);