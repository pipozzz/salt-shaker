CREATE TABLE `user_scope` (
	`user_id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`target_type` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
