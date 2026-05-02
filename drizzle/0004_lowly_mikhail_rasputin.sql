CREATE TABLE `hermes_channel_configs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`base_prompt` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hermes_channel_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`type` text DEFAULT 'url' NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `hermes_channel_configs`(`job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hermes_sources_job_idx` ON `hermes_channel_sources` (`job_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `hermes_sources_type_idx` ON `hermes_channel_sources` (`type`);