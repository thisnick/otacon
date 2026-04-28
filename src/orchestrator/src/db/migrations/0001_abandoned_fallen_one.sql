CREATE TABLE "account_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"credential_type" text NOT NULL,
	"identifier" text NOT NULL,
	"secrets" jsonb,
	"is_primary" boolean DEFAULT false,
	"verified" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_credential_type_identifier" UNIQUE("credential_type","identifier")
);
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_compacted_from_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "phone_id";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "host_url";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "local_phone_id";