ALTER TABLE "vuln_acceptance" ADD COLUMN "warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vuln_acceptance" ADD COLUMN "ended_notified_at" timestamp with time zone;