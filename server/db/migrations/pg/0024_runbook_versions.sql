CREATE TABLE "runbook_version" (
	"id" serial PRIMARY KEY NOT NULL,
	"runbook_id" integer NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"params" text NOT NULL,
	"steps" text NOT NULL,
	"runners" text DEFAULT '[]' NOT NULL,
	"how" text NOT NULL,
	"saved_by" text,
	"saved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runbook" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "runbook_run" ADD COLUMN "runbook_version" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "runbook_version_idx" ON "runbook_version" USING btree ("runbook_id","version");--> statement-breakpoint
INSERT INTO "runbook_version" ("runbook_id", "version", "name", "description", "params", "steps", "runners", "how", "saved_by", "saved_at") SELECT "id", 1, "name", "description", "params", "steps", "runners", 'upgrade', "created_by", "updated_at" FROM "runbook";