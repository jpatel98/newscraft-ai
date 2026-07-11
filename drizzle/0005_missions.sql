CREATE TABLE missions (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	description text DEFAULT '' NOT NULL,
	prompt text NOT NULL,
	schedule text NOT NULL,
	enabled integer DEFAULT 1 NOT NULL,
	delivery_target text DEFAULT 'database' NOT NULL,
	output_format text DEFAULT 'markdown' NOT NULL,
	backend_job_id text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE mission_sources (
	id text PRIMARY KEY NOT NULL,
	mission_id text NOT NULL,
	type text DEFAULT 'url' NOT NULL,
	name text NOT NULL,
	config_json text NOT NULL,
	enabled integer DEFAULT 1 NOT NULL,
	sort_order integer DEFAULT 0 NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	CONSTRAINT mission_sources_mission_id_missions_id_fk
		FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX mission_sources_mission_idx ON mission_sources (mission_id, sort_order);
--> statement-breakpoint
CREATE INDEX mission_sources_type_idx ON mission_sources (type);
--> statement-breakpoint
CREATE TABLE mission_runs (
	id text PRIMARY KEY NOT NULL,
	mission_id text NOT NULL,
	status text NOT NULL,
	started_at text,
	completed_at text,
	elapsed_ms bigint,
	last_error text,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	CONSTRAINT mission_runs_mission_id_missions_id_fk
		FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX mission_runs_mission_started_idx ON mission_runs (mission_id, started_at);
--> statement-breakpoint
CREATE TABLE mission_reports (
	id text PRIMARY KEY NOT NULL,
	mission_id text NOT NULL,
	mission_name text NOT NULL,
	run_time text,
	schedule text,
	filename text NOT NULL,
	file_path_display text NOT NULL,
	output_format text DEFAULT 'markdown' NOT NULL,
	response_markdown text NOT NULL,
	preview text NOT NULL,
	source_mtime_ms bigint DEFAULT 0 NOT NULL,
	legacy_channel_post_id text,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX mission_reports_mission_run_idx ON mission_reports (mission_id, run_time);
--> statement-breakpoint
CREATE INDEX mission_reports_path_idx ON mission_reports (file_path_display);
--> statement-breakpoint
CREATE INDEX mission_reports_legacy_post_idx ON mission_reports (legacy_channel_post_id);
--> statement-breakpoint
INSERT INTO mission_reports (
	id,
	mission_id,
	mission_name,
	run_time,
	schedule,
	filename,
	file_path_display,
	output_format,
	response_markdown,
	preview,
	source_mtime_ms,
	legacy_channel_post_id,
	created_at,
	updated_at
)
SELECT
	id,
	job_id,
	channel,
	run_time,
	schedule,
	filename,
	file_path_display,
	'markdown',
	response_markdown,
	preview,
	source_mtime_ms,
	id,
	created_at,
	updated_at
FROM agent_channel_posts
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO missions (
	id,
	name,
	description,
	prompt,
	schedule,
	enabled,
	delivery_target,
	output_format,
	backend_job_id,
	created_at,
	updated_at
)
SELECT
	job_id,
	job_id,
	'',
	base_prompt,
	'',
	1,
	'database',
	'markdown',
	job_id,
	created_at,
	updated_at
FROM agent_channel_configs
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO mission_sources (
	id,
	mission_id,
	type,
	name,
	config_json,
	enabled,
	sort_order,
	created_at,
	updated_at
)
SELECT
	id,
	job_id,
	type,
	name,
	config_json,
	enabled,
	sort_order,
	created_at,
	updated_at
FROM agent_channel_sources
ON CONFLICT (id) DO NOTHING;
