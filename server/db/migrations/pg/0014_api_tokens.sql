CREATE TABLE "api_token" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_token_token_hash_unique" UNIQUE("token_hash")
);
