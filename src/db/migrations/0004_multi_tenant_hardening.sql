CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `organization_id` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `slug` text;
--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_memberships_org_user` ON `organization_memberships` (`organization_id`,`user_id`);
--> statement-breakpoint
CREATE TABLE `organization_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`accepted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_invites_token_hash_unique` ON `organization_invites` (`token_hash`);
--> statement-breakpoint
CREATE TABLE `organization_agent_settings` (
	`organization_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`name` text,
	`description` text,
	`instructions` text,
	`user_prompt_tuning` text,
	`preferred_source_urls` text DEFAULT '[]',
	`model` text,
	`enabled_tools` text,
	`is_enabled` integer DEFAULT true NOT NULL,
	`policy` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_by_user_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_agent_settings_org_agent` ON `organization_agent_settings` (`organization_id`,`agent_id`);
--> statement-breakpoint
CREATE TABLE `agent_output_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`validation_status` text NOT NULL,
	`verifier_score` real,
	`issues` text DEFAULT '[]',
	`latency_ms` integer,
	`tool_failure_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `organizations` (`id`, `slug`, `name`, `status`, `created_at`)
VALUES ('org-newscraft', 'newscraft', 'NewsCraft', 'active', (unixepoch() * 1000))
ON CONFLICT(`slug`) DO NOTHING;
--> statement-breakpoint
UPDATE `workspaces`
SET
	`organization_id` = COALESCE(`organization_id`, 'org-newscraft'),
	`slug` = COALESCE(`slug`, CASE WHEN `id` = 'default' THEN 'main' ELSE `id` END);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_org_slug_unique` ON `workspaces` (`organization_id`,`slug`);
--> statement-breakpoint
INSERT INTO `organization_memberships` (`organization_id`, `user_id`, `role`, `created_at`)
SELECT DISTINCT
	COALESCE(w.`organization_id`, 'org-newscraft') AS `organization_id`,
	wm.`user_id`,
	wm.`role`,
	wm.`created_at`
FROM `workspace_memberships` wm
JOIN `workspaces` w ON w.`id` = wm.`workspace_id`
ON CONFLICT(`organization_id`, `user_id`) DO NOTHING;
--> statement-breakpoint
INSERT INTO `organization_agent_settings` (
	`organization_id`,
	`agent_id`,
	`name`,
	`description`,
	`instructions`,
	`user_prompt_tuning`,
	`preferred_source_urls`,
	`model`,
	`enabled_tools`,
	`is_enabled`,
	`policy`,
	`updated_at`,
	`updated_by_user_id`
)
SELECT
	w.`organization_id`,
	was.`agent_id`,
	was.`name`,
	was.`description`,
	was.`instructions`,
	was.`user_prompt_tuning`,
	was.`preferred_source_urls`,
	was.`model`,
	was.`enabled_tools`,
	was.`is_enabled`,
	was.`policy`,
	was.`updated_at`,
	was.`updated_by_user_id`
FROM `workspace_agent_settings` was
JOIN `workspaces` w ON w.`id` = was.`workspace_id`
WHERE w.`organization_id` IS NOT NULL
ON CONFLICT(`organization_id`, `agent_id`) DO NOTHING;
