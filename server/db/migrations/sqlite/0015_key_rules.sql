CREATE TABLE `key_rule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`expires_at` integer NOT NULL,
	`max_accepts` integer NOT NULL,
	`accepted` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
