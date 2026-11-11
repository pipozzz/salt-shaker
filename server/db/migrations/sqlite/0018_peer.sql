CREATE TABLE `peer` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL
);
