ALTER TABLE `commands` ADD `projection_token` text;--> statement-breakpoint
ALTER TABLE `commands` ADD `processing_stage` text;--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`notification_id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`recipient_ciphertext` text NOT NULL,
	`body_text` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_command_kind` ON `notification_outbox` (`command_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_notification_status_updated` ON `notification_outbox` (`status`,`updated_at`);
