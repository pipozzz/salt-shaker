CREATE TABLE `vuln_acceptance` (
	`vuln_id` text PRIMARY KEY NOT NULL,
	`note` text NOT NULL,
	`accepted_by` text,
	`accepted_at` integer NOT NULL,
	`expires_at` integer
);
