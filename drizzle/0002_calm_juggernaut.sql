CREATE TABLE agent_channel_posts (
	id text PRIMARY KEY NOT NULL,
	job_id text NOT NULL,
	channel text NOT NULL,
	run_time text,
	schedule text,
	filename text NOT NULL,
	file_path_display text NOT NULL,
	response_markdown text NOT NULL,
	preview text NOT NULL,
	source_mtime_ms bigint DEFAULT 0 NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX agent_posts_job_run_idx ON agent_channel_posts (job_id, run_time);
--> statement-breakpoint
CREATE INDEX agent_posts_path_idx ON agent_channel_posts (file_path_display);
