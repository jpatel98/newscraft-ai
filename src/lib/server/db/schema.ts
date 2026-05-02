import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable(
	'accounts',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull(),
		name: text('name').notNull().default(''),
		passwordHash: text('password_hash'),
		setupTokenHash: text('setup_token_hash'),
		setupTokenExpiresAt: integer('setup_token_expires_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		lastLoginAt: integer('last_login_at')
	},
	(t) => ({
		emailUnique: uniqueIndex('accounts_email_unique').on(t.email),
		setupTokenIdx: index('accounts_setup_token_idx').on(t.setupTokenHash)
	})
);

export const conversations = sqliteTable('conversations', {
	id: text('id').primaryKey(),
	title: text('title').notNull().default(''),
	systemPrompt: text('system_prompt'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	pinned: integer('pinned').notNull().default(0)
});

export const messages = sqliteTable(
	'messages',
	{
		id: text('id').primaryKey(),
		conversationId: text('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
		content: text('content').notNull(),
		toolCalls: text('tool_calls'),
		partial: integer('partial').notNull().default(0),
		createdAt: integer('created_at').notNull()
	},
	(t) => ({
		convoIdx: index('messages_convo_created_idx').on(t.conversationId, t.createdAt)
	})
);

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

export const hermesChannelPosts = sqliteTable(
	'hermes_channel_posts',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id').notNull(),
		channel: text('channel').notNull(),
		runTime: text('run_time'),
		schedule: text('schedule'),
		filename: text('filename').notNull(),
		filePathDisplay: text('file_path_display').notNull(),
		responseMarkdown: text('response_markdown').notNull(),
		preview: text('preview').notNull(),
		sourceMtimeMs: integer('source_mtime_ms').notNull().default(0),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => ({
		jobRunIdx: index('hermes_posts_job_run_idx').on(t.jobId, t.runTime),
		pathIdx: index('hermes_posts_path_idx').on(t.filePathDisplay)
	})
);

export const missions = sqliteTable('missions', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	description: text('description').notNull().default(''),
	prompt: text('prompt').notNull(),
	schedule: text('schedule').notNull(),
	enabled: integer('enabled').notNull().default(1),
	deliveryTarget: text('delivery_target').notNull().default('database'),
	outputFormat: text('output_format').notNull().default('markdown'),
	backendJobId: text('backend_job_id').notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const missionSources = sqliteTable(
	'mission_sources',
	{
		id: text('id').primaryKey(),
		missionId: text('mission_id')
			.notNull()
			.references(() => missions.id, { onDelete: 'cascade' }),
		type: text('type', { enum: ['url'] }).notNull().default('url'),
		name: text('name').notNull(),
		configJson: text('config_json').notNull(),
		enabled: integer('enabled').notNull().default(1),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => ({
		missionIdx: index('mission_sources_mission_idx').on(t.missionId, t.sortOrder),
		typeIdx: index('mission_sources_type_idx').on(t.type)
	})
);

export const missionRuns = sqliteTable(
	'mission_runs',
	{
		id: text('id').primaryKey(),
		missionId: text('mission_id')
			.notNull()
			.references(() => missions.id, { onDelete: 'cascade' }),
		status: text('status').notNull(),
		startedAt: text('started_at'),
		completedAt: text('completed_at'),
		elapsedMs: integer('elapsed_ms'),
		lastError: text('last_error'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => ({
		missionStartedIdx: index('mission_runs_mission_started_idx').on(t.missionId, t.startedAt)
	})
);

export const missionReports = sqliteTable(
	'mission_reports',
	{
		id: text('id').primaryKey(),
		missionId: text('mission_id').notNull(),
		missionName: text('mission_name').notNull(),
		runTime: text('run_time'),
		schedule: text('schedule'),
		filename: text('filename').notNull(),
		filePathDisplay: text('file_path_display').notNull(),
		outputFormat: text('output_format').notNull().default('markdown'),
		responseMarkdown: text('response_markdown').notNull(),
		preview: text('preview').notNull(),
		sourceMtimeMs: integer('source_mtime_ms').notNull().default(0),
		legacyChannelPostId: text('legacy_channel_post_id'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => ({
		missionRunIdx: index('mission_reports_mission_run_idx').on(t.missionId, t.runTime),
		pathIdx: index('mission_reports_path_idx').on(t.filePathDisplay),
		legacyIdx: index('mission_reports_legacy_post_idx').on(t.legacyChannelPostId)
	})
);

export const hermesChannelConfigs = sqliteTable('hermes_channel_configs', {
	jobId: text('job_id').primaryKey(),
	basePrompt: text('base_prompt').notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const hermesChannelSources = sqliteTable(
	'hermes_channel_sources',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id')
			.notNull()
			.references(() => hermesChannelConfigs.jobId, { onDelete: 'cascade' }),
		type: text('type', { enum: ['url'] }).notNull().default('url'),
		name: text('name').notNull(),
		configJson: text('config_json').notNull(),
		enabled: integer('enabled').notNull().default(1),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => ({
		jobIdx: index('hermes_sources_job_idx').on(t.jobId, t.sortOrder),
		typeIdx: index('hermes_sources_type_idx').on(t.type)
	})
);
