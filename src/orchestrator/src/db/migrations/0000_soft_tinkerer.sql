CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"phone_id" text NOT NULL,
	"host_url" text NOT NULL,
	"local_phone_id" text NOT NULL,
	"display_name" text,
	"account_type" text DEFAULT 'xhs' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"session_id" text NOT NULL,
	"action_type" text NOT NULL,
	"target" text,
	"details" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"team_name" text NOT NULL,
	"agent_role" text NOT NULL,
	"workflow_id" text,
	"hook_token" text,
	"status" text DEFAULT 'created' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_conversation_role" UNIQUE("conversation_id","agent_role")
);
--> statement-breakpoint
CREATE TABLE "agent_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"signal_type" text NOT NULL,
	"hook_token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"resolution" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_key" text NOT NULL,
	"blob_path" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"compacted_from" text,
	"summary_blob_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_signals" ADD CONSTRAINT "agent_signals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_compacted_from_conversations_id_fk" FOREIGN KEY ("compacted_from") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;