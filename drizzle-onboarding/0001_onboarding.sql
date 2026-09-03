CREATE TABLE `onboarding_workspaces` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`owner_hash` text NOT NULL,
	`tenant_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`token_expires_at` integer NOT NULL,
	`refresh_expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_onboarding_owner_active` ON `onboarding_workspaces` (`owner_hash`) WHERE `revoked_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_onboarding_tenant_created` ON `onboarding_workspaces` (`tenant_hash`,`created_at`);
--> statement-breakpoint
CREATE TABLE `onboarding_pair_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`task_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `onboarding_workspaces`(`workspace_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_onboarding_pair_workspace` ON `onboarding_pair_codes` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `onboarding_agent_credentials` (
	`credential_hash` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`task_id` text NOT NULL,
	`revoked_at` integer,
	`last_seen_at` integer,
	`first_receipt_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `onboarding_workspaces`(`workspace_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_onboarding_agent_id` ON `onboarding_agent_credentials` (`agent_id`);
--> statement-breakpoint
CREATE INDEX `idx_onboarding_agent_workspace` ON `onboarding_agent_credentials` (`workspace_id`,`created_at`);
