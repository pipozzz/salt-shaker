CREATE TABLE "job" (
	"jid" text PRIMARY KEY NOT NULL,
	"fun" text NOT NULL,
	"args" text,
	"target" text,
	"target_type" text,
	"salt_user" text,
	"shaker_user" text,
	"minions" text,
	"dry_run" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_return" (
	"jid" text NOT NULL,
	"minion" text NOT NULL,
	"ret" text,
	"retcode" integer,
	"success" boolean,
	"summary" text,
	"returned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "job_return_jid_minion_pk" PRIMARY KEY("jid","minion")
);
--> statement-breakpoint
CREATE INDEX "job_started_at_idx" ON "job" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "job_fun_idx" ON "job" USING btree ("fun");