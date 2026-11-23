CREATE TABLE "user_invite" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"name" text,
	"role" text NOT NULL,
	"scope_target" text,
	"scope_target_type" text,
	"token_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_invite_username_unique" UNIQUE("username"),
	CONSTRAINT "user_invite_token_hash_unique" UNIQUE("token_hash")
);
