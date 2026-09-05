import { bigint, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';

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

export const sessions = pgTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		createdAt: timestampMs('created_at').notNull(),
		expiresAt: timestampMs('expires_at').notNull(),
		revokedAt: timestampMs('revoked_at'),
		lastSeenAt: timestampMs('last_seen_at')
	},
	(t) => ({
		accountIdx: index('sessions_account_idx').on(t.accountId),
		expiresIdx: index('sessions_expires_idx').on(t.expiresAt)
	})
);

export const organizations = pgTable('organizations', {
	id: text('id').primaryKey(),
	name: text('name').notNull().default('Newsroom'),
	createdAt: timestampMs('created_at').notNull(),
	updatedAt: timestampMs('updated_at').notNull()
});

export const organizationMembers = pgTable(
	'organization_members',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		accountOrgUnique: uniqueIndex('organization_members_account_org_unique').on(t.accountId, t.orgId),
		orgIdx: index('organization_members_org_idx').on(t.orgId),
		accountIdx: index('organization_members_account_idx').on(t.accountId)
	})
);

export const newsroomProfiles = pgTable('newsroom_profiles', {
	orgId: text('org_id')
		.primaryKey()
		.references(() => organizations.id, { onDelete: 'cascade' }),
	timezone: text('timezone').notNull().default('UTC'),
	homeMarket: text('home_market').notNull().default(''),
	preferredDomains: jsonb('preferred_domains').$type<string[]>().notNull().default([]),
	createdAt: timestampMs('created_at').notNull(),
	updatedAt: timestampMs('updated_at').notNull()
});

export const conversations = pgTable('conversations', {
	id: text('id').primaryKey(),
	accountId: text('account_id')
		.notNull()
		.references(() => accounts.id, { onDelete: 'cascade' }),
	orgId: text('org_id').references(() => organizations.id, { onDelete: 'set null' }),
	title: text('title').notNull().default(''),
	systemPrompt: text('system_prompt'),
	createdAt: timestampMs('created_at').notNull(),
	updatedAt: timestampMs('updated_at').notNull(),
	pinned: integer('pinned').notNull().default(0)
}, (t) => ({
	accountUpdatedIdx: index('conversations_account_updated_idx').on(t.accountId, t.updatedAt),
	orgUpdatedIdx: index('conversations_org_updated_idx').on(t.orgId, t.updatedAt),
	accountPinnedUpdatedIdx: index('conversations_account_pinned_updated_idx').on(
		t.accountId,
		t.pinned,
		t.updatedAt
	)
}));

export const conversationDocuments = pgTable(
	'conversation_documents',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		conversationId: text('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		originalFilename: text('original_filename').notNull(),
		storagePath: text('storage_path').notNull(),
		mimeType: text('mime_type', { enum: ['application/pdf'] }).notNull().default('application/pdf'),
		sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
		checksumSha256: text('checksum_sha256').notNull(),
		processingState: text('processing_state', {
			enum: ['uploading', 'processing', 'ready', 'failed']
		})
			.notNull()
			.default('uploading'),
		pageCount: integer('page_count'),
		failureCode: text('failure_code'),
		failureMessage: text('failure_message'),
		processingStartedAt: timestampMs('processing_started_at'),
		processedAt: timestampMs('processed_at'),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		storagePathUnique: uniqueIndex('conversation_documents_storage_path_unique').on(t.storagePath),
		ownerIdx: index('conversation_documents_owner_idx').on(
			t.accountId,
			t.conversationId,
			t.createdAt
		),
		orgIdx: index('conversation_documents_org_idx').on(t.orgId, t.updatedAt),
		stateIdx: index('conversation_documents_state_idx').on(t.processingState, t.updatedAt)
	})
);

export const conversationDocumentPages = pgTable(
	'conversation_document_pages',
	{
		// search_vector is generated and indexed by migration 0013, then queried through raw SQL.
		id: text('id').primaryKey(),
		documentId: text('document_id')
			.notNull()
			.references(() => conversationDocuments.id, { onDelete: 'cascade' }),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		conversationId: text('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		pageNumber: integer('page_number').notNull(),
		pageText: text('page_text').notNull(),
		charCount: integer('char_count').notNull(),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		documentPageUnique: uniqueIndex('conversation_document_pages_document_number_unique').on(
			t.documentId,
			t.pageNumber
		),
		ownerIdx: index('conversation_document_pages_owner_idx').on(
			t.accountId,
			t.conversationId,
			t.documentId,
			t.pageNumber
		),
		orgIdx: index('conversation_document_pages_org_idx').on(t.orgId, t.documentId, t.pageNumber)
	})
);

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
		resumeClaimedAt: timestampMs('resume_claimed_at'),
		createdAt: timestampMs('created_at').notNull()
	},
	(t) => ({
		convoIdx: index('messages_convo_created_idx').on(t.conversationId, t.createdAt)
	})
);

export const messageProvenance = pgTable(
	'message_provenance',
	{
		messageId: text('message_id')
			.primaryKey()
			.references(() => messages.id, { onDelete: 'cascade' }),
		conversationId: text('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		provenanceJson: text('provenance_json').notNull(),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		conversationUpdatedIdx: index('message_provenance_conversation_updated_idx').on(
			t.conversationId,
			t.updatedAt
		)
	})
);

export const hermesRuns = pgTable(
	'hermes_runs',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		orgId: text('org_id').references(() => organizations.id, { onDelete: 'set null' }),
		conversationId: text('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		userMessageId: text('user_message_id').references(() => messages.id, { onDelete: 'set null' }),
		assistantMessageId: text('assistant_message_id')
			.notNull()
			.references(() => messages.id, { onDelete: 'cascade' }),
		idempotencyKey: text('idempotency_key').notNull(),
		tenantKey: text('tenant_key').notNull(),
		sessionId: text('session_id').notNull(),
		inputJson: text('input_json').notNull(),
		seededCitationsJson: text('seeded_citations_json').notNull().default('[]'),
		state: text('state').notNull().default('queued'),
		answerText: text('answer_text').notNull().default(''),
		sourcesJson: text('sources_json').notNull().default('[]'),
		citationsJson: text('citations_json').notNull().default('[]'),
			toolsJson: text('tools_json').notNull().default('[]'),
		cursor: integer('cursor').notNull().default(0),
		workerCursor: integer('worker_cursor').notNull().default(0),
		errorMessage: text('error_message'),
		cancelRequestedAt: timestampMs('cancel_requested_at'),
		leaseOwner: text('lease_owner'),
		leaseToken: text('lease_token'),
		leaseExpiresAt: timestampMs('lease_expires_at'),
		createdAt: timestampMs('created_at').notNull(),
		startedAt: timestampMs('started_at'),
		updatedAt: timestampMs('updated_at').notNull(),
		completedAt: timestampMs('completed_at')
	},
	(t) => ({
		accountIdempotencyUnique: uniqueIndex('hermes_runs_account_idempotency_unique').on(
			t.accountId,
			t.idempotencyKey
		),
		conversationStateIdx: index('hermes_runs_conversation_state_idx').on(
			t.accountId,
			t.conversationId,
			t.state,
			t.updatedAt
		),
		leaseIdx: index('hermes_runs_lease_idx').on(t.state, t.leaseExpiresAt),
		accountUpdatedIdx: index('hermes_runs_account_updated_idx').on(t.accountId, t.updatedAt)
	})
);

export const hermesRunEvents = pgTable(
	'hermes_run_events',
	{
		runId: text('run_id')
			.notNull()
			.references(() => hermesRuns.id, { onDelete: 'cascade' }),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		cursor: integer('cursor').notNull(),
		eventType: text('event_type').notNull(),
		dataJson: text('data_json').notNull(),
		createdAt: timestampMs('created_at').notNull()
	},
	(t) => ({
		primary: primaryKey({ columns: [t.runId, t.cursor] }),
		accountCursorIdx: index('hermes_run_events_account_cursor_idx').on(
			t.accountId,
			t.runId,
			t.cursor
		)
	})
);

/**
 * Conversation artifacts are references to server-owned immutable object
 * versions.  The revision row itself is immutable; only its lifecycle status
 * and safe error metadata may change while publication is in flight.
 */
export const artifactFamilies = pgTable(
	'artifact_families',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		orgId: text('org_id').references(() => organizations.id, { onDelete: 'set null' }),
		conversationId: text('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		sourceMessageId: text('source_message_id')
			.notNull()
			.references(() => messages.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['chart', 'table', 'image', 'markdown', 'map'] }).notNull(),
		title: text('title').notNull(),
		latestRevisionId: text('latest_revision_id'),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		ownerMessageIdx: index('artifact_families_owner_message_idx').on(
			t.accountId,
			t.conversationId,
			t.sourceMessageId,
			t.updatedAt
		),
		conversationIdx: index('artifact_families_conversation_idx').on(t.accountId, t.conversationId, t.updatedAt)
	})
);

export const artifactRevisions = pgTable(
	'artifact_revisions',
	{
		id: text('id').primaryKey(),
		familyId: text('family_id')
			.notNull()
			.references(() => artifactFamilies.id, { onDelete: 'cascade' }),
		revision: integer('revision').notNull(),
		status: text('status', {
			enum: ['draft', 'publishing', 'ready', 'failed', 'cancelled', 'missing']
		})
			.notNull()
			.default('draft'),
		specJson: text('spec_json').notNull(),
		specSha256: text('spec_sha256').notNull(),
		baseRevisionId: text('base_revision_id'),
		errorCode: text('error_code'),
		errorMessage: text('error_message'),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull(),
		readyAt: timestampMs('ready_at')
	},
	(t) => ({
		familyRevisionUnique: uniqueIndex('artifact_revisions_family_revision_unique').on(t.familyId, t.revision),
		familyStatusIdx: index('artifact_revisions_family_status_idx').on(t.familyId, t.status, t.updatedAt)
	})
);

export const artifactAssets = pgTable(
	'artifact_assets',
	{
		id: text('id').primaryKey(),
		revisionId: text('revision_id')
			.notNull()
			.references(() => artifactRevisions.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ['source', 'preview', 'data'] }).notNull(),
		objectKey: text('object_key').notNull(),
		objectVersion: text('object_version').notNull(),
		mimeType: text('mime_type').notNull(),
		sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
		checksumSha256: text('checksum_sha256').notNull(),
		width: integer('width'),
		height: integer('height'),
		createdAt: timestampMs('created_at').notNull(),
		verifiedAt: timestampMs('verified_at').notNull()
	},
	(t) => ({
		revisionRoleUnique: uniqueIndex('artifact_assets_revision_role_unique').on(t.revisionId, t.role),
		objectVersionUnique: uniqueIndex('artifact_assets_object_version_unique').on(t.objectKey, t.objectVersion),
		revisionIdx: index('artifact_assets_revision_idx').on(t.revisionId, t.createdAt)
	})
);

export const artifactUploadGrants = pgTable(
	'artifact_upload_grants',
	{
		id: text('id').primaryKey(),
		revisionId: text('revision_id')
			.notNull()
			.references(() => artifactRevisions.id, { onDelete: 'cascade' }),
		runId: text('run_id').references(() => hermesRuns.id, { onDelete: 'set null' }),
		role: text('role', { enum: ['source', 'preview', 'data'] }).notNull(),
		producerKey: text('producer_key').notNull(),
		tokenHash: text('token_hash').notNull(),
		stagingKey: text('staging_key').notNull(),
		finalKey: text('final_key').notNull(),
		uploadedObjectVersion: text('uploaded_object_version'),
		allowedMime: text('allowed_mime').notNull(),
		maxBytes: bigint('max_bytes', { mode: 'number' }).notNull(),
		exactBytes: bigint('exact_bytes', { mode: 'number' }),
		expectedSha256: text('expected_sha256'),
		expiresAt: timestampMs('expires_at').notNull(),
		state: text('state', { enum: ['issued', 'uploaded', 'consumed', 'expired', 'revoked'] })
			.notNull()
			.default('issued'),
		createdAt: timestampMs('created_at').notNull(),
		uploadedAt: timestampMs('uploaded_at'),
		consumedAt: timestampMs('consumed_at')
	},
	(t) => ({
		producerUnique: uniqueIndex('artifact_upload_grants_producer_unique').on(
			t.revisionId,
			t.role,
			t.producerKey
		),
		stagingKeyUnique: uniqueIndex('artifact_upload_grants_staging_key_unique').on(t.stagingKey),
		runIdx: index('artifact_upload_grants_run_idx').on(t.runId, t.state, t.expiresAt)
	})
);

export const artifactVerifications = pgTable(
	'artifact_verifications',
	{
		id: text('id').primaryKey(),
		grantId: text('grant_id').references(() => artifactUploadGrants.id, { onDelete: 'set null' }),
		objectKey: text('object_key').notNull(),
		objectVersion: text('object_version').notNull(),
		status: text('status', { enum: ['verified', 'rejected'] }).notNull(),
		mimeType: text('mime_type'),
		sizeBytes: bigint('size_bytes', { mode: 'number' }),
		checksumSha256: text('checksum_sha256'),
		width: integer('width'),
		height: integer('height'),
		reasonCode: text('reason_code'),
		detailsJson: text('details_json').notNull().default('{}'),
		createdAt: timestampMs('created_at').notNull()
	},
	(t) => ({
		objectVersionIdx: index('artifact_verifications_object_version_idx').on(t.objectKey, t.objectVersion, t.createdAt),
		grantIdx: index('artifact_verifications_grant_idx').on(t.grantId, t.createdAt)
	})
);

export const hermesRunArtifactRefs = pgTable(
	'hermes_run_artifact_refs',
	{
		runId: text('run_id')
			.notNull()
			.references(() => hermesRuns.id, { onDelete: 'cascade' }),
		revisionId: text('revision_id')
			.notNull()
			.references(() => artifactRevisions.id, { onDelete: 'cascade' }),
			cursor: integer('cursor').notNull(),
		createdAt: timestampMs('created_at').notNull()
	},
	(t) => ({
		primary: primaryKey({ columns: [t.runId, t.revisionId] }),
		cursorIdx: index('hermes_run_artifact_refs_cursor_idx').on(t.runId, t.cursor)
	})
);

export const chatFeedback = pgTable(
	'chat_feedback',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		orgId: text('org_id').references(() => organizations.id, { onDelete: 'set null' }),
		conversationId: text('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		comment: text('comment').notNull(),
		snapshotJson: text('snapshot_json').notNull(),
		linearIssueId: text('linear_issue_id'),
		linearIssueIdentifier: text('linear_issue_identifier'),
		linearIssueUrl: text('linear_issue_url'),
		userAgent: text('user_agent'),
		createdAt: timestampMs('created_at').notNull()
	},
	(t) => ({
		accountCreatedIdx: index('chat_feedback_account_created_idx').on(t.accountId, t.createdAt),
		orgCreatedIdx: index('chat_feedback_org_created_idx').on(t.orgId, t.createdAt),
		conversationCreatedIdx: index('chat_feedback_conversation_created_idx').on(
			t.conversationId,
			t.createdAt
		)
	})
);

export const chatDiagnostics = pgTable(
	'chat_diagnostics',
	{
		id: text('id').primaryKey(),
		conversationId: text('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		type: text('type').notNull(),
		detailsJson: text('details_json').notNull(),
		createdAt: timestampMs('created_at').notNull()
	},
	(t) => ({
		conversationCreatedIdx: index('chat_diagnostics_conversation_created_idx').on(
			t.conversationId,
			t.createdAt
		),
		typeCreatedIdx: index('chat_diagnostics_type_created_idx').on(t.type, t.createdAt)
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
	orgId: text('org_id').references(() => organizations.id, { onDelete: 'set null' }),
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
	accountIdx: index('missions_account_idx').on(t.accountId),
	orgIdx: index('missions_org_idx').on(t.orgId)
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
		orgId: text('org_id').references(() => organizations.id, { onDelete: 'set null' }),
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
		orgUpdatedIdx: index('mission_reports_org_updated_idx').on(t.orgId, t.updatedAt),
		missionRunIdx: index('mission_reports_mission_run_idx').on(t.missionId, t.runTime),
		pathIdx: index('mission_reports_path_idx').on(t.filePathDisplay),
		legacyIdx: index('mission_reports_legacy_post_idx').on(t.legacyChannelPostId)
	})
);

export const agentJobs = pgTable(
	'agent_jobs',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		orgId: text('org_id').references(() => organizations.id, { onDelete: 'set null' }),
		state: text('state', { enum: ['queued', 'running', 'succeeded', 'failed', 'paused'] })
			.notNull()
			.default('queued'),
		lastRunId: text('last_run_id'),
		lastRunAt: timestampMs('last_run_at'),
		lastError: text('last_error'),
		createdAt: timestampMs('created_at').notNull(),
		updatedAt: timestampMs('updated_at').notNull()
	},
	(t) => ({
		accountJobIdx: index('agent_jobs_account_job_idx').on(t.accountId, t.id),
		stateIdx: index('agent_jobs_state_idx').on(t.state),
		orgIdx: index('agent_jobs_org_idx').on(t.orgId)
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
