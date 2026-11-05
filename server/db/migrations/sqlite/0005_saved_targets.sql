CREATE TABLE `saved_target` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`target` text NOT NULL,
	`target_type` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_target_name_unique` ON `saved_target` (`name`);