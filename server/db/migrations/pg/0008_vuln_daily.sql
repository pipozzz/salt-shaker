CREATE TABLE "vuln_daily" (
	"day" text PRIMARY KEY NOT NULL,
	"critical" integer NOT NULL,
	"high" integer NOT NULL,
	"medium" integer NOT NULL,
	"low" integer NOT NULL,
	"unknown" integer NOT NULL,
	"fixable" integer NOT NULL,
	"minions" integer NOT NULL,
	"affected" integer NOT NULL
);
