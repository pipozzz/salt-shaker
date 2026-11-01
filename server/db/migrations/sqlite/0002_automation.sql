CREATE TABLE `notification_channel` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`last_sent_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `schedule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`fun` text,
	`args` text,
	`target` text NOT NULL,
	`target_type` text NOT NULL,
	`cron` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_run_at` integer,
	`last_jid` text,
	`last_summary` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_name_unique` ON `schedule` (`name`);