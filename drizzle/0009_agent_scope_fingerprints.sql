ALTER TABLE `agent_events` ADD `record_id` text;--> statement-breakpoint
ALTER TABLE `agent_events` ADD `payload_fingerprint` text;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `payload_fingerprint` text;--> statement-breakpoint
ALTER TABLE `agent_receipts` ADD `payload_fingerprint` text;--> statement-breakpoint
CREATE INDEX `idx_agent_events_record_occurred` ON `agent_events` (`record_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `feishu_event_receipts` (
	`event_id` text PRIMARY KEY NOT NULL,
	`payload_fingerprint` text NOT NULL,
	`event_type` text NOT NULL,
	`message_id` text,
	`status` text NOT NULL,
	`command_id` text,
	`run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `commands`(`command_id`)
);--> statement-breakpoint
CREATE INDEX `idx_feishu_event_receipts_created` ON `feishu_event_receipts` (`created_at`);
