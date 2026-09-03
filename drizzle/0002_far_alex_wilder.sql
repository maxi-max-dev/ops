ALTER TABLE `commands` ADD `receipt_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_commands_receipt_id` ON `commands` (`receipt_id`);