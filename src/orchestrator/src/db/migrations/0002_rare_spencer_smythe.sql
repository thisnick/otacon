CREATE TABLE "phone_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"phone_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phone_allocations" ADD CONSTRAINT "phone_allocations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_phone_allocations_lookup" ON "phone_allocations" USING btree ("phone_id","conversation_id","allocated_at" DESC NULLS LAST);