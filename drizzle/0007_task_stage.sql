ALTER TABLE `task_entities` ADD `stage` text NOT NULL DEFAULT 'open';
--> statement-breakpoint
UPDATE `task_entities` SET `stage` = CASE WHEN `state` = 1 THEN 'done' ELSE 'open' END;
