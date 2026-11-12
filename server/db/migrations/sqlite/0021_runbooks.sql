CREATE TABLE `runbook` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`params` text NOT NULL,
	`steps` text NOT NULL,
	`created_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runbook_name_unique` ON `runbook` (`name`);--> statement-breakpoint
CREATE TABLE `runbook_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`runbook_id` integer,
	`name` text NOT NULL,
	`params` text NOT NULL,
	`steps` text NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`started_by` text NOT NULL,
	`started_by_id` text NOT NULL,
	`decided_by` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text
);
