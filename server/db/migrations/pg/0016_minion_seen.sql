CREATE TABLE "minion_seen" (
	"minion" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
