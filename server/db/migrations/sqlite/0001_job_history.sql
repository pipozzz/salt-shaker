CREATE TABLE `job` (
	`jid` text PRIMARY KEY NOT NULL,
	`fun` text NOT NULL,
	`args` text,
	`target` text,
	`target_type` text,
	`salt_user` text,
	`shaker_user` text,
	`minions` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_started_at_idx` ON `job` (`started_at`);--> statement-breakpoint
CREATE INDEX `job_fun_idx` ON `job` (`fun`);--> statement-breakpoint
CREATE TABLE `job_return` (
	`jid` text NOT NULL,
	`minion` text NOT NULL,
	`ret` text,
	`retcode` integer,
	`success` integer,
	`summary` text,
	`returned_at` integer NOT NULL,
	PRIMARY KEY(`jid`, `minion`)
);
