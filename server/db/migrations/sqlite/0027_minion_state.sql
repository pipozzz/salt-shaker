CREATE TABLE `minion` (
	`id` text PRIMARY KEY NOT NULL,
	`grains` text,
	`up` integer,
	`status_at` integer,
	`compliance_status` text,
	`compliance_jid` text,
	`compliance_at` integer,
	`updates_packages` integer,
	`updates_jid` text,
	`updates_at` integer
);
