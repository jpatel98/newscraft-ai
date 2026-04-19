ALTER TABLE `workspace_agent_settings`
ADD `user_prompt_tuning` text;
--> statement-breakpoint
ALTER TABLE `workspace_agent_settings`
ADD `preferred_source_urls` text DEFAULT '[]';
