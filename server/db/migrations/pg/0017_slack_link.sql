CREATE TABLE "slack_link" (
	"team" text NOT NULL,
	"slack_user" text NOT NULL,
	"user_id" text NOT NULL,
	"slack_name" text,
	"linked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_link_team_slack_user_pk" PRIMARY KEY("team","slack_user")
);
