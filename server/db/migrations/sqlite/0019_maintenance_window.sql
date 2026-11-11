CREATE TABLE `maintenance_window` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`days` text NOT NULL,
	`start` text NOT NULL,
	`minutes` integer NOT NULL,
	`timezone` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `schedule` ADD `window_id` integer;