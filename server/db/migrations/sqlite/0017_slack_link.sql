CREATE TABLE `slack_link` (
	`team` text NOT NULL,
	`slack_user` text NOT NULL,
	`user_id` text NOT NULL,
	`slack_name` text,
	`linked_at` integer NOT NULL,
	PRIMARY KEY(`team`, `slack_user`)
);
