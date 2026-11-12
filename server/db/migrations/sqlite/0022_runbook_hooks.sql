CREATE TABLE `runbook_hook` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`runbook_id` integer NOT NULL,
	`secret` text NOT NULL,
	`params` text NOT NULL,
	`from_request` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_called_at` integer,
	`last_run_id` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runbook_hook_name_unique` ON `runbook_hook` (`name`);