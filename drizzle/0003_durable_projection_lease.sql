ALTER TABLE `commands` ADD `projection_applied_at` integer;--> statement-breakpoint
ALTER TABLE `commands` ADD `processing_token` text;--> statement-breakpoint
ALTER TABLE `commands` ADD `processing_lease_until` integer;
