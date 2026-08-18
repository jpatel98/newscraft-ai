/**
 * The schema is prepared by an explicit operator/development command.  Keep
 * this contract small and dependency-free so health/status code can inspect
 * migration state without importing the migration loader or executing DDL.
 */
export const MIGRATION_TABLE = 'newscraft_schema_migrations';

export const MIGRATION_VERSIONS = [
	'0000_init',
	'0001_fts',
	'0002_calm_juggernaut',
	'0003_mushy_vertigo',
	'0004_lowly_mikhail_rasputin',
	'0005_missions',
	'0006_account_scopes',
	'0007_chat_diagnostics',
	'0008_message_provenance',
	'0009_sessions',
	'0010_org_foundation',
	'0011_agent_jobs',
	'0012_newsroom_profiles',
	'0013_conversation_documents',
	'0014_runtime_reconciliation',
	'0015_durable_hermes_runs'
] as const;

/** Versions represented by the legacy runtime-created schema. */
export const LEGACY_MIGRATION_COUNT = 14;

export const REQUIRED_SCHEMA_TABLES = [
	'accounts',
	'sessions',
	'organizations',
	'organization_members',
	'newsroom_profiles',
	'conversations',
	'conversation_documents',
	'conversation_document_pages',
	'messages',
	'message_provenance',
	'chat_feedback',
	'chat_diagnostics',
	'settings',
	'agent_channel_posts',
	'agent_channel_configs',
	'agent_channel_sources',
	'missions',
	'mission_sources',
	'mission_runs',
	'mission_reports',
	'agent_jobs'
] as const;

/** Columns touched by the legacy-schema baseline reconciliation. */
export const REQUIRED_SCHEMA_COLUMNS = {
	accounts: ['id', 'role', 'created_at'],
	organizations: ['id', 'name', 'created_at', 'updated_at'],
	organization_members: ['id', 'org_id', 'account_id', 'role', 'created_at', 'updated_at'],
	conversations: ['account_id', 'org_id'],
	missions: ['account_id', 'org_id'],
	mission_reports: ['account_id', 'org_id'],
	agent_jobs: ['account_id', 'org_id'],
	chat_feedback: ['account_id', 'org_id'],
	settings: ['key', 'value']
} as const satisfies Record<string, readonly string[]>;

export const EXPECTED_MIGRATION_COUNT = MIGRATION_VERSIONS.length;
