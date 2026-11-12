CREATE TABLE "runbook" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"params" text NOT NULL,
	"steps" text NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runbook_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "runbook_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"runbook_id" integer,
	"name" text NOT NULL,
	"params" text NOT NULL,
	"steps" text NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"started_by" text NOT NULL,
	"started_by_id" text NOT NULL,
	"decided_by" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
