CREATE TABLE "minion" (
	"id" text PRIMARY KEY NOT NULL,
	"grains" text,
	"up" boolean,
	"status_at" timestamp with time zone,
	"compliance_status" text,
	"compliance_jid" text,
	"compliance_at" timestamp with time zone,
	"updates_packages" integer,
	"updates_jid" text,
	"updates_at" timestamp with time zone
);
