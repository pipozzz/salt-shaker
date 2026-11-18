CREATE TABLE "vuln_report" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"built_at" timestamp with time zone NOT NULL,
	"data" text NOT NULL
);
