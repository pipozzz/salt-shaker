ALTER TABLE "job" ADD COLUMN "returned" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "job" SET
	"returned" = (SELECT count(*) FROM "job_return" WHERE "job_return"."jid" = "job"."jid"),
	"failed" = (SELECT count(*) FROM "job_return" WHERE "job_return"."jid" = "job"."jid" AND ("job_return"."retcode" <> 0 OR "job_return"."success" = false));
