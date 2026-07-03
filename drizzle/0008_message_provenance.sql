CREATE TABLE IF NOT EXISTS "message_provenance" (
	"message_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"provenance_json" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "message_provenance_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade,
	CONSTRAINT "message_provenance_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_provenance_conversation_updated_idx" ON "message_provenance" ("conversation_id","updated_at");
