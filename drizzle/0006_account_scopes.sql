ALTER TABLE `conversations` ADD `account_id` text REFERENCES accounts(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `hermes_channel_posts` ADD `account_id` text REFERENCES accounts(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `missions` ADD `account_id` text REFERENCES accounts(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `mission_reports` ADD `account_id` text REFERENCES accounts(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `hermes_channel_configs` ADD `account_id` text REFERENCES accounts(id) ON DELETE cascade;
--> statement-breakpoint
UPDATE `conversations`
SET `account_id` = (SELECT `id` FROM `accounts` ORDER BY `created_at` ASC LIMIT 1)
WHERE `account_id` IS NULL;
--> statement-breakpoint
UPDATE `hermes_channel_posts`
SET `account_id` = (SELECT `id` FROM `accounts` ORDER BY `created_at` ASC LIMIT 1)
WHERE `account_id` IS NULL;
--> statement-breakpoint
UPDATE `missions`
SET `account_id` = (SELECT `id` FROM `accounts` ORDER BY `created_at` ASC LIMIT 1)
WHERE `account_id` IS NULL;
--> statement-breakpoint
UPDATE `mission_reports`
SET `account_id` = (SELECT `id` FROM `accounts` ORDER BY `created_at` ASC LIMIT 1)
WHERE `account_id` IS NULL;
--> statement-breakpoint
UPDATE `hermes_channel_configs`
SET `account_id` = (SELECT `id` FROM `accounts` ORDER BY `created_at` ASC LIMIT 1)
WHERE `account_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `conversations_account_updated_idx` ON `conversations` (`account_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `hermes_posts_account_job_idx` ON `hermes_channel_posts` (`account_id`,`job_id`);
--> statement-breakpoint
CREATE INDEX `missions_account_idx` ON `missions` (`account_id`);
--> statement-breakpoint
CREATE INDEX `mission_reports_account_mission_idx` ON `mission_reports` (`account_id`,`mission_id`);
