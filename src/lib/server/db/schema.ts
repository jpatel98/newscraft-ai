import { bigint, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

const timestampMs = (name: string) => bigint(name, { mode: 'number' });

export const accounts = pgTable(
	'accounts',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull(),
		name: text('name').notNull().default(''),
		role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
		passwordHash: text('password_hash'),
		setupTokenHash: text('setup_token_hash'),
		setupTokenExpiresAt: timestampMs('setup_token_expires_at'),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull(),
		lastLoginAt: timestampMs('last_login_at')
	},
	(t) => ({
		emailUnique: uniqueIndex('accounts_email_unique').on(t.email),
		setupTokenIdx: index('accounts_setup_token_idx').on(t.setupTokenHash)
	})
);

export const conversations = pgTable('conversations', {
	id: text('id').primaryKey(),
	accountId: text('account_id')
		.notNull()
		.references(() => accounts.id, { onDelete: 'cascade' }),
	title: text('title').notNull().default(''),
	systemPrompt: text('system_prompt'),
	createdAt: timestampMs('created_at').notNull(),
	updatedAt: timestampMs('updated_at').notNull(),
	pinned: integer('pinned').notNull().default(0)
}, (t) => ({
	accountUpdatedIdx: index('conversations_account_updated_idx').on(t.accountId, t.updatedAt),
	accountPinnedUpdatedIdx: index('conversations_account_pinned_updated_idx').on(
		t.accountId,
		t.pinned,
		t.updatedAt
	)
}));

export const messages = pgTable(
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
		createdAt: timestampMs('created_at').notNull()
	},
	(t) => ({
		convoIdx: index('messages_convo_created_idx').on(t.conversationId, t.createdAt)
	})
);

export const chatFeedback = pgTable(
	'chat_feedback',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		conversationId: text('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		comment: text('comment').notNull(),
		snapshotJson: text('snapshot_json').notNull(),
		userAgent: text('user_agent'),
		createdAt: timestampMs('created_at').notNull()
	},
	(t) => ({
		accountCreatedIdx: index('chat_feedback_account_created_idx').on(t.accountId, t.createdAt),
		conversationCreatedIdx: index('chat_feedback_conversation_created_idx').on(
			t.conversationId,
			t.createdAt
		)
	})
);

export const settings = pgTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

export const agentChannelPosts = pgTable(
	'agent_channel_posts',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		jobId: text('job_id').notNull(),
		channel: text('channel').notNull(),
		runTime: text('run_time'),
		schedule: text('schedule'),
		filename: text('filename').notNull(),
		filePathDisplay: text('file_path_display').notNull(),
		responseMarkdown: text('response_markdown').notNull(),
		preview: text('preview').notNull(),
		sourceMtimeMs: timestampMs('source_mtime_ms').notNull().default(0),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		accountJobIdx: index('agent_posts_account_job_idx').on(t.accountId, t.jobId),
		jobRunIdx: index('agent_posts_job_run_idx').on(t.jobId, t.runTime),
		pathIdx: index('agent_posts_path_idx').on(t.filePathDisplay)
	})
);

export const missions = pgTable('missions', {
	id: text('id').primaryKey(),
	accountId: text('account_id')
		.notNull()
		.references(() => accounts.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	description: text('description').notNull().default(''),
	prompt: text('prompt').notNull(),
	schedule: text('schedule').notNull(),
	enabled: integer('enabled').notNull().default(1),
	deliveryTarget: text('delivery_target').notNull().default('database'),
	outputFormat: text('output_format').notNull().default('markdown'),
	backendJobId: text('backend_job_id').notNull(),
	createdAt: timestampMs('created_at').notNull(),
	updatedAt: timestampMs('updated_at').notNull()
}, (t) => ({
	accountIdx: index('missions_account_idx').on(t.accountId)
}));

export const missionSources = pgTable(
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
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		missionIdx: index('mission_sources_mission_idx').on(t.missionId, t.sortOrder),
		typeIdx: index('mission_sources_type_idx').on(t.type)
	})
);

export const missionRuns = pgTable(
	'mission_runs',
	{
		id: text('id').primaryKey(),
		missionId: text('mission_id')
			.notNull()
			.references(() => missions.id, { onDelete: 'cascade' }),
		status: text('status').notNull(),
		startedAt: text('started_at'),
		completedAt: text('completed_at'),
		elapsedMs: timestampMs('elapsed_ms'),
		lastError: text('last_error'),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		missionStartedIdx: index('mission_runs_mission_started_idx').on(t.missionId, t.startedAt)
	})
);

export const missionReports = pgTable(
	'mission_reports',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		missionId: text('mission_id').notNull(),
		missionName: text('mission_name').notNull(),
		runTime: text('run_time'),
		schedule: text('schedule'),
		filename: text('filename').notNull(),
		filePathDisplay: text('file_path_display').notNull(),
		outputFormat: text('output_format').notNull().default('markdown'),
		responseMarkdown: text('response_markdown').notNull(),
		preview: text('preview').notNull(),
		sourceMtimeMs: timestampMs('source_mtime_ms').notNull().default(0),
		legacyChannelPostId: text('legacy_channel_post_id'),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		accountMissionIdx: index('mission_reports_account_mission_idx').on(t.accountId, t.missionId),
		accountUpdatedIdx: index('mission_reports_account_updated_idx').on(t.accountId, t.updatedAt),
		missionRunIdx: index('mission_reports_mission_run_idx').on(t.missionId, t.runTime),
		pathIdx: index('mission_reports_path_idx').on(t.filePathDisplay),
		legacyIdx: index('mission_reports_legacy_post_idx').on(t.legacyChannelPostId)
	})
);

export const agentChannelConfigs = pgTable('agent_channel_configs', {
	jobId: text('job_id').primaryKey(),
	accountId: text('account_id')
		.notNull()
		.references(() => accounts.id, { onDelete: 'cascade' }),
	basePrompt: text('base_prompt').notNull(),
	createdAt: timestampMs('created_at').notNull(),
	updatedAt: timestampMs('updated_at').notNull()
});

export const agentChannelSources = pgTable(
	'agent_channel_sources',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id')
			.notNull()
			.references(() => agentChannelConfigs.jobId, { onDelete: 'cascade' }),
		type: text('type', { enum: ['url'] }).notNull().default('url'),
		name: text('name').notNull(),
		configJson: text('config_json').notNull(),
		enabled: integer('enabled').notNull().default(1),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		jobIdx: index('agent_sources_job_idx').on(t.jobId, t.sortOrder),
		typeIdx: index('agent_sources_type_idx').on(t.type)
	})
);
