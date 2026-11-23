CREATE TABLE `user_invite` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`name` text,
	`role` text NOT NULL,
	`scope_target` text,
	`scope_target_type` text,
	`token_hash` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_invite_username_unique` ON `user_invite` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_invite_token_hash_unique` ON `user_invite` (`token_hash`);