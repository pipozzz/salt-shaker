CREATE TABLE "maintenance_window" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"days" text NOT NULL,
	"start" text NOT NULL,
	"minutes" integer NOT NULL,
	"timezone" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "window_id" integer;