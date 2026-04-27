CREATE TABLE `hermes_channel_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`channel` text NOT NULL,
	`run_time` text,
	`schedule` text,
	`filename` text NOT NULL,
	`file_path_display` text NOT NULL,
	`response_markdown` text NOT NULL,
	`preview` text NOT NULL,
	`source_mtime_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hermes_posts_job_run_idx` ON `hermes_channel_posts` (`job_id`,`run_time`);--> statement-breakpoint
CREATE INDEX `hermes_posts_path_idx` ON `hermes_channel_posts` (`file_path_display`);