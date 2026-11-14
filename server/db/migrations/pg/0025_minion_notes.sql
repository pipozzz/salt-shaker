CREATE TABLE "minion_note" (
	"minion" text PRIMARY KEY NOT NULL,
	"note" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone NOT NULL
);
