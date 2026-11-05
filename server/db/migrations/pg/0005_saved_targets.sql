CREATE TABLE "saved_target" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"target_type" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "saved_target_name_unique" UNIQUE("name")
);
