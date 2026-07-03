CREATE TABLE `chat_diagnostics` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`type` text NOT NULL,
	`details_json` text NOT NULL,
	`created_at` bigint NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_diagnostics_conversation_created_idx` ON `chat_diagnostics` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `chat_diagnostics_type_created_idx` ON `chat_diagnostics` (`type`,`created_at`);
