CREATE TABLE agent_channel_configs (
	job_id text PRIMARY KEY NOT NULL,
	base_prompt text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE agent_channel_sources (
	id text PRIMARY KEY NOT NULL,
	job_id text NOT NULL,
	type text DEFAULT 'url' NOT NULL,
	name text NOT NULL,
	config_json text NOT NULL,
	enabled integer DEFAULT 1 NOT NULL,
	sort_order integer DEFAULT 0 NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	CONSTRAINT agent_channel_sources_job_id_agent_channel_configs_job_id_fk
		FOREIGN KEY (job_id) REFERENCES agent_channel_configs(job_id) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX agent_sources_job_idx ON agent_channel_sources (job_id, sort_order);
--> statement-breakpoint
CREATE INDEX agent_sources_type_idx ON agent_channel_sources (type);
