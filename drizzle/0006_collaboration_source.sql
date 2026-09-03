CREATE TABLE `source_events` (
	`source_event_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`actor` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`detail` text NOT NULL,
	`source_path` text NOT NULL,
	`source_hash` text NOT NULL,
	`task_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_source_events_source_hash` ON `source_events` (`source`,`source_hash`);
--> statement-breakpoint
CREATE INDEX `idx_source_events_occurred_at` ON `source_events` (`occurred_at`);
