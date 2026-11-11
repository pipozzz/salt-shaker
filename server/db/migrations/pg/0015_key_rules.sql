CREATE TABLE "key_rule" (
	"id" serial PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_accepts" integer NOT NULL,
	"accepted" text DEFAULT '[]' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL
);
