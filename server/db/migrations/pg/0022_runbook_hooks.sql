CREATE TABLE "runbook_hook" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"runbook_id" integer NOT NULL,
	"secret" text NOT NULL,
	"params" text NOT NULL,
	"from_request" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_called_at" timestamp with time zone,
	"last_run_id" integer,
	"last_error" text,
	CONSTRAINT "runbook_hook_name_unique" UNIQUE("name")
);
