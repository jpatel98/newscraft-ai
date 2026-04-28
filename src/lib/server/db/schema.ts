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
