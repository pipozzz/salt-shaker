CREATE TABLE "saved_query" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sql" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "saved_query_name_unique" UNIQUE("name")
);
