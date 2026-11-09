CREATE TABLE "vuln_acceptance" (
	"vuln_id" text PRIMARY KEY NOT NULL,
	"note" text NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone
);
