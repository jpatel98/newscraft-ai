import type {
	CreateJobInput,
	NewsroomCrawlPlanArticleBodyStrategy,
	NewsroomCrawlPlanCandidateLinkDto,
	NewsroomCrawlPlanChangeDetection,
	NewsroomCrawlPlanPoliteFetchOverridesDto,
	NewsroomCrawlPlanStatus,
	NewsroomCrawlPlanVersionDto,
	NewsroomGateDto,
	NewsroomGateStatus,
	NewsroomGateType,
	NewsroomEventDto,
	NewsroomEventJson,
	NewsroomJobDto,
	NewsroomReportDto,
	NewsroomRunDto,
	NewsroomRunStepDto,
	NewsroomSourceDto,
	NewsroomToolCallDto,
	QueueGateInput,
	ResolveGateInput,
	ResolveGateResult,
	SaveCrawlPlanVersionInput,
	RunStatus,
	UpdateJobInput
} from '@newscraft/shared';
import type { HarnessDb } from './database.js';
import { newId, nowIso } from '../util/ids.js';
import { computeNextRunAt } from '../jobs/schedule.js';

interface JobRow {
	id: string;
	workspace_id: string;
	name: string;
	description: string;
	prompt: string;
	schedule: string;
	enabled: 0 | 1;
	next_run_at: string | null;
	last_run_at: string | null;
	last_status: string | null;
	last_error: string | null;
	last_delivery_error: string | null;
	deliver: string | null;
	output_format: string;
	created_at: string;
	updated_at: string;
}

interface RunRow {
	id: string;
	job_id: string;
	status: RunStatus;
	trigger: string;
	queued_at: string | null;
	started_at: string | null;
	completed_at: string | null;
	updated_at: string | null;
	elapsed_ms: number | null;
	last_error: string | null;
	job_name?: string | null;
}

interface RunStepRow {
	id: number;
	run_id: string;
	step_type: string;
	label: string;
	status: string;
	started_at: string;
	completed_at: string | null;
}

interface ToolCallRow {
	id: string;
	run_id: string | null;
	name: string;
	status: string;
	started_at: string;
	completed_at: string | null;
	error: string | null;
}

interface SourceRow {
	id: string;
	run_id: string;
	job_id: string | null;
	url: string;
	title: string;
	fetched_at: string;
	snippet: string;
	summary: string;
	used: 0 | 1;
}

interface ReportRow {
	id: string;
	run_id: string;
	job_id: string;
	title: string;
	markdown: string;
	created_at: string;
	ingest_status: 'not_configured' | 'sent' | 'failed';
	ingest_error: string | null;
}

interface EventRow {
	id: string;
	workspace_id: string;
	story_id: string | null;
	job_id: string | null;
	run_id: string | null;
	agent: string;
	kind: string;
	payload_json: string;
	sources_json: string;
	parent_event_id: string | null;
	cost_metadata_json: string | null;
	created_at: string;
}

interface GateRow {
	id: string;
	workspace_id: string;
	story_id: string | null;
	job_id: string | null;
	run_id: string | null;
	type: NewsroomGateType;
	title: string;
	summary: string;
	status: NewsroomGateStatus;
	priority: number;
	payload_json: string;
	actions_json: string;
	created_by: string;
	created_at: string;
	resolved_at: string | null;
	resolved_by: string | null;
	resolution_action: string | null;
	resolution_notes: string | null;
	resolution_payload_json: string | null;
	resolution_event_id: string | null;
}

type MemoryTier = 'house' | 'beat' | 'story';

interface HouseMemoryRow {
	key: string;
	value_json: string;
	updated_at: string;
}

interface MemoryEntryRow {
	id: string;
	workspace_id: string;
	tier: MemoryTier;
	scope_id: string;
	key: string;
	kind: string;
	value_json: string;
	actor: string;
	created_at: string;
}

export interface StoreSourceInput {
	runId: string;
	jobId: string | null;
	url: string;
	title: string;
	fetchedAt: string;
	snippet: string;
	summary: string;
	used: boolean;
	contentText: string;
	contentHash: string;
	contentType?: string | null;
	statusCode?: number | null;
	archiveSnapshotUrl?: string | null;
	metadata?: unknown;
	provenance?: unknown;
	healthGate?: unknown | null;
}

export const DEFAULT_WORKSPACE_ID = 'default';

export interface AppendEventInput {
	workspaceId?: string;
	storyId?: string | null;
	jobId?: string | null;
	runId?: string | null;
	agent: string;
	kind: string;
	payload?: unknown;
	sources?: unknown[];
	parentEventId?: string | null;
	costMetadata?: unknown | null;
	createdAt?: string;
}

export interface ListEventsOptions {
	workspaceId?: string;
	storyId?: string | null;
	jobId?: string | null;
	runId?: string | null;
	afterId?: string | null;
	limit?: number;
}

export interface ListGatesOptions {
	workspaceId?: string;
	storyId?: string | null;
	jobId?: string | null;
	runId?: string | null;
	status?: NewsroomGateStatus | 'all';
	limit?: number;
}

export interface MemoryEntryDto {
	id: string;
	workspace_id: string;
	tier: MemoryTier;
	scope_id: string;
	key: string;
	kind: string;
	value: NewsroomEventJson;
	actor: string;
	created_at: string;
}

export interface HouseMemoryInspectDto {
	tier: 'house';
	scope_id: 'global';
	current: Record<string, NewsroomEventJson>;
	required_keys: string[];
	updated_at: string | null;
	entries: MemoryEntryDto[];
}

export interface ScopedMemoryInspectDto {
	tier: 'beat' | 'story';
	scope_id: string;
	current: Record<string, NewsroomEventJson[]>;
	required_keys: string[];
	entries: MemoryEntryDto[];
	agent_event_log?: NewsroomEventDto[];
}

export interface AppendMemoryInput {
	key: string;
	value: unknown;
	workspaceId?: string;
	workspace_id?: string;
	kind?: string;
	actor?: string;
	createdAt?: string;
}

const HOUSE_MEMORY_KEYS = [
	'style_guide',
	'banned_phrases',
	'libel_patterns',
	'gazetteer',
	'model_preferences',
	'beats'
] as const;

const BEAT_MEMORY_KEYS = [
	'crawl_plans',
	'source_quality',
	'prior_coverage',
	'peer_coverage',
	'editor_accept_patterns',
	'editor_spike_patterns'
] as const;

const STORY_MEMORY_KEYS = ['fact_ledger', 'draft_history', 'agent_event_log', 'editor_decisions'] as const;

const GATE_TYPES: readonly NewsroomGateType[] = [
	'pitch',
	'verification',
	'draft_review',
	'legal_style',
	'publish',
	'crawl_plan',
	'source_health',
	'budget'
];

const DEFAULT_GATE_ACTIONS: Record<NewsroomGateType, string[]> = {
	pitch: ['accept', 'hold', 'spike'],
	verification: ['mark_verified', 'mark_disputed', 'request_more_research'],
	draft_review: ['approve', 'return_with_notes', 'spike'],
	legal_style: ['approve', 'edit', 'block'],
	publish: ['approve', 'hold', 'send_to_cms'],
	crawl_plan: ['approve', 'edit', 'reject'],
	source_health: ['pause', 'retry', 'drop'],
	budget: ['approve_overage', 'reduce_scope', 'pause']
};

const CRAWL_PLAN_BODY_STRATEGIES: readonly NewsroomCrawlPlanArticleBodyStrategy[] = [
	'auto',
	'selector',
	'agent-extract'
];

const CRAWL_PLAN_CHANGE_DETECTION: readonly NewsroomCrawlPlanChangeDetection[] = [
	'hash',
	'structured_diff',
	'semantic_similarity'
];

const CRAWL_PLAN_STATUSES: readonly NewsroomCrawlPlanStatus[] = ['pending', 'approved', 'rejected'];

const DEFAULT_CRAWL_PLAN_POLITE_FETCH: NewsroomCrawlPlanPoliteFetchOverridesDto = {
	respect_robots: true,
	robots_override: false,
	host_delay_ms: 250,
	failure_budget: 3,
	archive_web: true
};

export class HarnessRepository {
	constructor(private db: HarnessDb) {}

	healthcheck(): boolean {
		this.db.prepare('SELECT 1').get();
		return true;
	}

	close(): void | Promise<void> {
		this.db.close();
	}

	appendEvent(input: AppendEventInput): NewsroomEventDto {
		const id = newId('event');
		const workspaceId = requiredText(input.workspaceId || DEFAULT_WORKSPACE_ID, 'workspace_id');
		const agent = requiredText(input.agent, 'agent');
		const kind = requiredText(input.kind, 'kind');
		const createdAt = input.createdAt || nowIso();
		this.db
			.prepare(
				`INSERT INTO events (
					id, workspace_id, story_id, job_id, run_id, agent, kind, payload_json,
					sources_json, parent_event_id, cost_metadata_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				workspaceId,
				optionalText(input.storyId),
				optionalText(input.jobId),
				optionalText(input.runId),
				agent,
				kind,
				stringifyJson(input.payload ?? {}),
				stringifyJson(input.sources ?? []),
				optionalText(input.parentEventId),
				input.costMetadata === undefined || input.costMetadata === null
					? null
					: stringifyJson(input.costMetadata),
				createdAt
			);
		return this.requireEvent(id);
	}

	getEvent(id: string): NewsroomEventDto | null {
		const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
		return row ? eventDto(row) : null;
	}

	requireEvent(id: string): NewsroomEventDto {
		const event = this.getEvent(id);
		if (!event) throw new Error('Event not found');
		return event;
	}

	listEvents(options: ListEventsOptions = {}): NewsroomEventDto[] {
		const conditions: string[] = ['workspace_id = ?'];
		const params: unknown[] = [requiredText(options.workspaceId || DEFAULT_WORKSPACE_ID, 'workspace_id')];
		addNullableFilter(conditions, params, 'story_id', options.storyId);
		addNullableFilter(conditions, params, 'job_id', options.jobId);
		addNullableFilter(conditions, params, 'run_id', options.runId);
		if (options.afterId) {
			const after = this.db
				.prepare('SELECT rowid AS row_id, created_at FROM events WHERE id = ?')
				.get(options.afterId) as { row_id: number; created_at: string } | undefined;
			if (after) {
				conditions.push('(created_at > ? OR (created_at = ? AND rowid > ?))');
				params.push(after.created_at, after.created_at, after.row_id);
			}
		}
		params.push(clampEventLimit(options.limit));
		const rows = this.db
			.prepare(
				`SELECT * FROM events
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY created_at ASC, rowid ASC
				 LIMIT ?`
			)
			.all(...params) as EventRow[];
		return rows.map(eventDto);
	}

	queueGate(input: QueueGateInput): NewsroomGateDto {
		const id = newId('gate');
		const workspaceId = requiredText(input.workspace_id || DEFAULT_WORKSPACE_ID, 'workspace_id');
		const type = requiredGateType(input.type);
		const title = requiredText(input.title, 'gate title');
		const summary = requiredText(input.summary, 'gate summary');
		const priority = clampGatePriority(input.priority);
		const actions = normalizeGateActions(input.actions, type);
		const createdBy = requiredText(input.created_by || 'assignment_desk', 'created_by');
		const createdAt = input.created_at || nowIso();
		this.db
			.prepare(
				`INSERT INTO gates (
					id, workspace_id, story_id, job_id, run_id, type, title, summary, status,
					priority, payload_json, actions_json, created_by, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				workspaceId,
				optionalText(input.story_id),
				optionalText(input.job_id),
				optionalText(input.run_id),
				type,
				title,
				summary,
				priority,
				stringifyJson(input.payload ?? {}),
				stringifyJson(actions),
				createdBy,
				createdAt
			);
		this.appendEvent({
			workspaceId,
			storyId: input.story_id,
			jobId: input.job_id,
			runId: input.run_id,
			agent: createdBy,
			kind: 'gate.queued',
			payload: {
				gate_id: id,
				gate_type: type,
				title,
				summary,
				priority,
				actions,
				payload: input.payload ?? {}
			},
			createdAt
		});
		return this.requireGate(id);
	}

	getGate(id: string): NewsroomGateDto | null {
		const row = this.db.prepare('SELECT * FROM gates WHERE id = ?').get(id) as GateRow | undefined;
		return row ? gateDto(row) : null;
	}

	requireGate(id: string): NewsroomGateDto {
		const gate = this.getGate(id);
		if (!gate) throw new Error('Gate not found');
		return gate;
	}

	listGates(options: ListGatesOptions = {}): NewsroomGateDto[] {
		const conditions: string[] = ['workspace_id = ?'];
		const params: unknown[] = [requiredText(options.workspaceId || DEFAULT_WORKSPACE_ID, 'workspace_id')];
		addNullableFilter(conditions, params, 'story_id', options.storyId);
		addNullableFilter(conditions, params, 'job_id', options.jobId);
		addNullableFilter(conditions, params, 'run_id', options.runId);
		const status = options.status || 'open';
		if (status !== 'all') {
			conditions.push('status = ?');
			params.push(requiredGateStatus(status));
		}
		params.push(clampGateLimit(options.limit));
		const order =
			status === 'open'
				? 'priority ASC, created_at ASC, rowid ASC'
				: 'created_at DESC, rowid DESC';
		const rows = this.db
			.prepare(
				`SELECT * FROM gates
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY ${order}
				 LIMIT ?`
			)
			.all(...params) as GateRow[];
		return rows.map(gateDto);
	}

	resolveGate(id: string, input: ResolveGateInput): ResolveGateResult {
		const gateId = requiredText(id, 'gate_id');
		const action = requiredText(input.action, 'gate action');
		const actor = requiredText(input.actor || 'editor', 'actor');
		const notes = optionalText(input.notes);
		const resolvedAt = input.resolved_at || nowIso();
		const tx = this.db.transaction(() => {
			const gate = this.requireGate(gateId);
			if (gate.status === 'resolved') throw new Error('Gate already resolved');
			if (gate.actions.length > 0 && !gate.actions.includes(action)) {
				throw new Error(`Unsupported gate action: ${action}`);
			}
			this.db
				.prepare(
					`UPDATE gates SET
						status = 'resolved',
						resolved_at = ?,
						resolved_by = ?,
						resolution_action = ?,
						resolution_notes = ?,
						resolution_payload_json = ?
					 WHERE id = ? AND status = 'open'`
				)
				.run(resolvedAt, actor, action, notes, stringifyJson(input.payload ?? null), gateId);
			const event = this.appendEvent({
				workspaceId: gate.workspace_id,
				storyId: gate.story_id,
				jobId: gate.job_id,
				runId: gate.run_id,
				agent: actor,
				kind: 'gate.resolved',
				payload: {
					gate_id: gate.id,
					gate_type: gate.type,
					title: gate.title,
					action,
					notes,
					payload: input.payload ?? null
				},
				createdAt: resolvedAt
			});
			this.db
				.prepare('UPDATE gates SET resolution_event_id = ? WHERE id = ?')
				.run(event.id, gateId);
			return { gate: this.requireGate(gateId), event };
		});
		return tx();
	}

	saveCrawlPlanVersion(input: SaveCrawlPlanVersionInput): NewsroomCrawlPlanVersionDto {
		const beatId = requiredText(input.beat_id, 'beat_id');
		const planId = optionalText(input.id) || newId('crawlplan');
		const existingVersions = this.listCrawlPlanVersions(beatId, planId);
		const latestVersion = Math.max(0, ...existingVersions.map((plan) => plan.version));
		const version = input.version ?? latestVersion + 1;
		if (!Number.isFinite(version) || version < 1) throw new Error('crawl plan version must be a positive number');
		if (existingVersions.some((plan) => plan.version === version)) {
			throw new Error(`Crawl plan version already exists: ${planId}@${version}`);
		}
		const createdAt = input.created_at || nowIso();
		const createdBy = requiredText(input.created_by || 'beat_monitor', 'created_by');
		const plan: NewsroomCrawlPlanVersionDto = {
			id: planId,
			beat_id: beatId,
			version,
			seed_urls: normalizeCrawlPlanSeedUrls(input),
			link_follow_rule: requiredText(input.link_follow_rule, 'link_follow_rule'),
			article_body_strategy: normalizeCrawlPlanBodyStrategy(input.article_body_strategy),
			polling_cadence: optionalText(input.polling_cadence) || 'inherit beat schedule',
			jitter_ms: clampNonNegativeInteger(input.jitter_ms, 0),
			change_detection: normalizeCrawlPlanChangeDetection(input.change_detection),
			status: normalizeCrawlPlanStatus(input.status),
			polite_fetch: normalizeCrawlPlanPoliteFetch(input.polite_fetch),
			candidate_links: normalizeCrawlPlanCandidateLinks(input.candidate_links),
			created_by: createdBy,
			created_at: createdAt,
			source_memory_entry_id: null,
			supersedes_version: latestVersion || null
		};
		const entry = this.insertMemoryEntry('beat', beatId, 'crawl_plans', 'crawl_plan.versioned', plan, createdBy, createdAt);
		const stored = { ...plan, source_memory_entry_id: entry.id };
		this.appendEvent({
			workspaceId: DEFAULT_WORKSPACE_ID,
			agent: createdBy,
			kind: 'crawl_plan.versioned',
			payload: {
				plan_id: stored.id,
				beat_id: beatId,
				version: stored.version,
				seed_urls: stored.seed_urls,
				supersedes_version: stored.supersedes_version,
				memory_entry_id: entry.id
			},
			createdAt
		});
		return stored;
	}

	listCrawlPlanVersions(beatId: string, planId?: string): NewsroomCrawlPlanVersionDto[] {
		const entries = this.listMemoryEntries('beat', requiredText(beatId, 'beat_id'), 'crawl_plans');
		return entries
			.map(crawlPlanVersionFromMemoryEntry)
			.filter((plan): plan is NewsroomCrawlPlanVersionDto => Boolean(plan))
			.filter((plan) => !planId || plan.id === planId)
			.sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version);
	}

	requireCrawlPlanVersion(beatId: string, planId: string, version?: number): NewsroomCrawlPlanVersionDto {
		const versions = this.listCrawlPlanVersions(beatId, requiredText(planId, 'plan_id'));
		const plan =
			version === undefined
				? versions.sort((left, right) => right.version - left.version)[0]
				: versions.find((candidate) => candidate.version === version);
		if (!plan) throw new Error('Crawl plan not found');
		return plan;
	}

	inspectHouseMemory(): HouseMemoryInspectDto {
		const rows = this.db.prepare('SELECT * FROM house_memory ORDER BY key ASC').all() as HouseMemoryRow[];
		const current = houseMemoryDefaults();
		let updatedAt: string | null = null;
		for (const row of rows) {
			current[row.key] = parseEventJson(row.value_json, null);
			updatedAt = latestIso([updatedAt, row.updated_at]);
		}
		return {
			tier: 'house',
			scope_id: 'global',
			current,
			required_keys: [...HOUSE_MEMORY_KEYS],
			updated_at: updatedAt,
			entries: this.listMemoryEntries('house', 'global')
		};
	}

	updateHouseMemory(values: Record<string, unknown>, actor = 'editor'): HouseMemoryInspectDto {
		const now = nowIso();
		const entries = Object.entries(values).filter(([key]) => HOUSE_MEMORY_KEYS.includes(key as any));
		if (entries.length === 0) throw new Error('No supported house memory keys provided');
		const tx = this.db.transaction(() => {
			for (const [key, value] of entries) {
				this.db
					.prepare(
						`INSERT INTO house_memory (key, value_json, updated_at)
						 VALUES (?, ?, ?)
						 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
					)
					.run(key, stringifyJson(value), now);
				this.insertMemoryEntry('house', 'global', key, 'house.updated', value, actor, now);
			}
		});
		tx();
		return this.inspectHouseMemory();
	}

	inspectBeatMemory(beatId: string): ScopedMemoryInspectDto {
		const scopeId = requiredText(beatId, 'beat_id');
		return {
			tier: 'beat',
			scope_id: scopeId,
			current: scopedMemoryCurrent(this.listMemoryEntries('beat', scopeId), BEAT_MEMORY_KEYS),
			required_keys: [...BEAT_MEMORY_KEYS],
			entries: this.listMemoryEntries('beat', scopeId)
		};
	}

	appendBeatMemory(beatId: string, input: AppendMemoryInput): MemoryEntryDto {
		const scopeId = requiredText(beatId, 'beat_id');
		const key = requiredMemoryKey(input.key, BEAT_MEMORY_KEYS, 'beat memory key');
		return this.insertMemoryEntry(
			'beat',
			scopeId,
			key,
			input.kind || `beat.${key}.recorded`,
			input.value,
			input.actor || 'agent',
			input.createdAt || nowIso()
		);
	}

	inspectStoryMemory(storyId: string, workspaceId = DEFAULT_WORKSPACE_ID): ScopedMemoryInspectDto {
		const scopeId = requiredText(storyId, 'story_id');
		const scopedWorkspaceId = requiredText(workspaceId || DEFAULT_WORKSPACE_ID, 'workspace_id');
		const entries = this.listMemoryEntries('story', scopeId, undefined, scopedWorkspaceId);
		const eventLog = this.listEvents({ workspaceId, storyId: scopeId, limit: 500 });
		return {
			tier: 'story',
			scope_id: scopeId,
			current: {
				...scopedMemoryCurrent(entries, STORY_MEMORY_KEYS),
				agent_event_log: eventLog as unknown as NewsroomEventJson[]
			},
			required_keys: [...STORY_MEMORY_KEYS],
			entries,
			agent_event_log: eventLog
		};
	}

	appendStoryMemory(storyId: string, input: AppendMemoryInput): MemoryEntryDto {
		const scopeId = requiredText(storyId, 'story_id');
		const key = requiredMemoryKey(input.key, STORY_MEMORY_KEYS, 'story memory key');
		const workspaceId = optionalText(input.workspaceId ?? input.workspace_id) || DEFAULT_WORKSPACE_ID;
		return this.insertMemoryEntry(
			'story',
			scopeId,
			key,
			input.kind || `story.${key}.recorded`,
			input.value,
			input.actor || 'agent',
			input.createdAt || nowIso(),
			workspaceId
		);
	}

	listMemoryEntries(tier: MemoryTier, scopeId: string, key?: string, workspaceId?: string): MemoryEntryDto[] {
		const scope = requiredText(scopeId, 'scope_id');
		const conditions = ['tier = ?', 'scope_id = ?'];
		const params: unknown[] = [tier, scope];
		if (key) {
			conditions.push('key = ?');
			params.push(key);
		}
		if (workspaceId) {
			conditions.push('workspace_id = ?');
			params.push(requiredText(workspaceId, 'workspace_id'));
		}
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_entries
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY created_at ASC, rowid ASC`
			)
			.all(...params) as MemoryEntryRow[];
		return rows.map(memoryEntryDto);
	}

	private insertMemoryEntry(
		tier: MemoryTier,
		scopeId: string,
		key: string,
		kind: string,
		value: unknown,
		actor: string,
		createdAt: string,
		workspaceId = DEFAULT_WORKSPACE_ID
	): MemoryEntryDto {
		const id = newId('mem');
		this.db
			.prepare(
				`INSERT INTO memory_entries (id, workspace_id, tier, scope_id, key, kind, value_json, actor, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				requiredText(workspaceId, 'workspace_id'),
				tier,
				requiredText(scopeId, 'scope_id'),
				requiredText(key, 'key'),
				requiredText(kind, 'kind'),
				stringifyJson(value),
				requiredText(actor, 'actor'),
				createdAt
			);
		return this.listMemoryEntries(tier, scopeId, key, workspaceId).find((entry) => entry.id === id) as MemoryEntryDto;
	}

	private jobIdForRun(runId: string): string | null {
		const row = this.db.prepare('SELECT job_id FROM runs WHERE id = ?').get(runId) as
			| { job_id: string }
			| undefined;
		return row?.job_id ?? null;
	}

	private workspaceIdForRun(runId: string): string {
		const row = this.db
			.prepare(
				`SELECT jobs.workspace_id
				 FROM runs JOIN jobs ON jobs.id = runs.job_id
				 WHERE runs.id = ?`
			)
			.get(runId) as { workspace_id: string | null } | undefined;
		return row?.workspace_id || DEFAULT_WORKSPACE_ID;
	}

	createJob(input: CreateJobInput): NewsroomJobDto {
		const now = nowIso();
		const id = newId('job');
		const workspaceId = optionalText(input.workspace_id) || DEFAULT_WORKSPACE_ID;
		const name = (input.name || input.title || '').trim();
		const prompt = (input.prompt || '').trim();
		const schedule = (input.schedule || input.cron || '').trim();
		if (!name) throw new Error('Mission name is required');
		if (!prompt) throw new Error('Mission prompt is required');
		if (!schedule) throw new Error('Mission schedule is required');
		const enabled = input.enabled !== false;
		const nextRunAt = enabled ? computeNextRunAt(schedule, now) : null;
		this.db
			.prepare(
				`INSERT INTO jobs (
					id, workspace_id, name, description, prompt, schedule, enabled, next_run_at, last_status,
					deliver, output_format, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				workspaceId,
				name,
				String(input.description || '').trim(),
				prompt,
				schedule,
				enabled ? 1 : 0,
				nextRunAt,
				enabled ? 'scheduled' : 'paused',
				input.deliver || null,
				input.output_format || input.outputFormat || 'markdown',
				now,
				now
			);
		return this.getJob(id) as NewsroomJobDto;
	}

	updateJob(id: string, input: UpdateJobInput): NewsroomJobDto {
		const existing = this.requireJob(id);
		const workspaceId = optionalText(input.workspace_id) || existing.workspace_id || DEFAULT_WORKSPACE_ID;
		const name = input.name ?? input.title ?? existing.name;
		const prompt = input.prompt ?? existing.prompt ?? '';
		const schedule = input.schedule ?? input.cron ?? existing.schedule;
		const enabled = input.enabled ?? existing.enabled;
		const now = nowIso();
		const nextRunAt = enabled ? computeNextRunAt(schedule, now) : null;
		this.db
			.prepare(
				`UPDATE jobs SET
					workspace_id = ?, name = ?, description = ?, prompt = ?, schedule = ?, enabled = ?, next_run_at = ?,
					last_status = CASE WHEN ? = 0 THEN 'paused' ELSE COALESCE(last_status, 'scheduled') END,
					deliver = ?, output_format = ?, updated_at = ?
				WHERE id = ?`
			)
			.run(
				workspaceId,
				name.trim(),
				input.description ?? existing.description ?? '',
				prompt.trim(),
				schedule.trim(),
				enabled ? 1 : 0,
				nextRunAt,
				enabled ? 1 : 0,
				input.deliver === undefined ? existing.deliver : input.deliver,
				input.output_format || input.outputFormat || existing.output_format,
				now,
				id
			);
		return this.requireJob(id);
	}

	deleteJob(id: string): boolean {
		return this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
	}

	getJob(id: string): NewsroomJobDto | null {
		const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
		return row ? jobDto(row) : null;
	}

	requireJob(id: string): NewsroomJobDto {
		const job = this.getJob(id);
		if (!job) throw new Error('Mission not found');
		return job;
	}

	listJobs(includeDisabled = false): NewsroomJobDto[] {
		const rows = this.db
			.prepare(
				includeDisabled
					? 'SELECT * FROM jobs ORDER BY created_at DESC'
					: 'SELECT * FROM jobs WHERE enabled = 1 ORDER BY created_at DESC'
			)
			.all() as JobRow[];
		return rows.map(jobDto);
	}

	setJobEnabled(id: string, enabled: boolean): NewsroomJobDto {
		const job = this.requireJob(id);
		const now = nowIso();
		this.db
			.prepare(
				`UPDATE jobs SET enabled = ?, next_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?`
			)
			.run(
				enabled ? 1 : 0,
				enabled ? computeNextRunAt(job.schedule, now) : null,
				enabled ? 'scheduled' : 'paused',
				now,
				id
			);
		return this.requireJob(id);
	}

	createRun(jobId: string, trigger: string): NewsroomRunDto {
		const job = this.requireJob(jobId);
		const now = nowIso();
		const id = newId('run');
		this.db
			.prepare(
				`INSERT INTO runs (id, job_id, status, trigger, queued_at, updated_at)
				 VALUES (?, ?, 'queued', ?, ?, ?)`
			)
			.run(id, job.id, trigger, now, now);
		this.db
			.prepare(
				`UPDATE jobs SET last_status = 'queued', last_error = NULL, updated_at = ? WHERE id = ?`
			)
			.run(now, job.id);
		this.appendEvent({
			workspaceId: workspaceIdForJob(job),
			jobId: job.id,
			runId: id,
			agent: 'runner',
			kind: 'run.created',
			payload: { trigger, status: 'queued' },
			createdAt: now
		});
		return this.requireRun(id);
	}

	updateRun(
		id: string,
		input: Partial<Pick<NewsroomRunDto, 'status' | 'started_at' | 'completed_at' | 'elapsed_ms' | 'last_error'>>
	): NewsroomRunDto {
		const current = this.requireRun(id);
		const now = nowIso();
		this.db
			.prepare(
				`UPDATE runs SET
					status = ?, started_at = ?, completed_at = ?, elapsed_ms = ?, last_error = ?, updated_at = ?
				WHERE id = ?`
			)
			.run(
				input.status ?? current.status,
				input.started_at ?? current.started_at,
				input.completed_at ?? current.completed_at,
				input.elapsed_ms ?? current.elapsed_ms,
				input.last_error ?? current.last_error,
				now,
				id
			);
		const updated = this.requireRun(id);
		this.db
			.prepare(
				`UPDATE jobs SET last_status = ?, last_error = ?, last_run_at = COALESCE(?, last_run_at), updated_at = ? WHERE id = ?`
			)
			.run(updated.status, updated.last_error, updated.started_at, now, updated.job_id);
		this.appendEvent({
			workspaceId: workspaceIdForJob(this.requireJob(updated.job_id)),
			jobId: updated.job_id,
			runId: updated.id,
			agent: 'runner',
			kind: 'run.updated',
			payload: {
				status: updated.status,
				started_at: updated.started_at,
				completed_at: updated.completed_at,
				elapsed_ms: updated.elapsed_ms,
				last_error: updated.last_error
			},
			createdAt: now
		});
		return updated;
	}

	completeJobSchedule(jobId: string): void {
		const job = this.requireJob(jobId);
		if (!job.enabled) return;
		this.db
			.prepare('UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?')
			.run(computeNextRunAt(job.schedule, nowIso()), nowIso(), jobId);
	}

	requireRun(id: string): NewsroomRunDto {
		const row = this.db
			.prepare(
				`SELECT runs.*, jobs.name AS job_name
				 FROM runs JOIN jobs ON jobs.id = runs.job_id
				 WHERE runs.id = ?`
			)
			.get(id) as RunRow | undefined;
		if (!row) throw new Error('Run not found');
		return runDto(row);
	}

	listRuns(options: { includeCompleted?: boolean; includeRecent?: boolean; jobIds?: string[] } = {}): NewsroomRunDto[] {
		const includeCompleted = options.includeCompleted ?? false;
		const jobIds = Array.from(new Set((options.jobIds ?? []).map(optionalText).filter((id): id is string => Boolean(id))));
		const conditions = includeCompleted ? [] : [`runs.status IN ('queued', 'running')`];
		const params: unknown[] = [];
		if (jobIds.length > 0) {
			conditions.push(`runs.job_id IN (${jobIds.map(() => '?').join(', ')})`);
			params.push(...jobIds);
		}
		params.push(options.includeRecent ? 50 : 200);
		const rows = this.db
			.prepare(
				`SELECT runs.*, jobs.name AS job_name FROM runs JOIN jobs ON jobs.id = runs.job_id
				 ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
				 ORDER BY COALESCE(runs.updated_at, runs.queued_at) DESC LIMIT ?`
			)
			.all(...params) as RunRow[];
		return rows.map((row) => this.runDtoWithProgress(row));
	}

	failStaleActiveRuns(cutoffIso: string, reason: string): number {
		const now = nowIso();
		const staleRuns = this.db
			.prepare(
				`SELECT runs.id, runs.job_id, runs.queued_at, runs.started_at
				 FROM runs
				 WHERE runs.status IN ('queued', 'running')
				   AND COALESCE(runs.updated_at, runs.started_at, runs.queued_at) < ?`
			)
			.all(cutoffIso) as Pick<RunRow, 'id' | 'job_id' | 'queued_at' | 'started_at'>[];
		for (const run of staleRuns) {
			const startedAt = run.started_at || run.queued_at || now;
			const elapsedMs = Math.max(0, Date.parse(now) - Date.parse(startedAt));
			this.db
				.prepare(
					`UPDATE runs
					 SET status = 'failed', completed_at = ?, elapsed_ms = ?, last_error = ?, updated_at = ?
					 WHERE id = ?`
				)
				.run(now, Number.isFinite(elapsedMs) ? elapsedMs : null, reason, now, run.id);
			this.db
				.prepare(`UPDATE jobs SET last_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
				.run(reason, now, run.job_id);
			this.appendEvent({
				workspaceId: workspaceIdForJob(this.requireJob(run.job_id)),
				jobId: run.job_id,
				runId: run.id,
				agent: 'runner',
				kind: 'run.stale_failed',
				payload: {
					status: 'failed',
					reason,
					cutoff_at: cutoffIso
				},
				createdAt: now
			});
		}
		return staleRuns.length;
	}

	private runDtoWithProgress(row: RunRow): NewsroomRunDto {
		const run = runDto(row);
		const steps = this.db
			.prepare(
				`SELECT id, run_id, step_type, label, status, started_at, completed_at
				 FROM run_steps
				 WHERE run_id = ?
				 ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
				 LIMIT 12`
			)
			.all(row.id) as RunStepRow[];
		const toolCalls = this.db
			.prepare(
				`SELECT id, run_id, name, status, started_at, completed_at, error
				 FROM tool_calls
				 WHERE run_id = ?
				 ORDER BY COALESCE(completed_at, started_at) DESC, started_at DESC
				 LIMIT 8`
			)
			.all(row.id) as ToolCallRow[];
		const sourceStats = this.db
			.prepare('SELECT COUNT(*) AS count, MAX(fetched_at) AS latest FROM sources WHERE run_id = ?')
			.get(row.id) as { count: number; latest: string | null } | undefined;
		const usableSourceStats = this.db
			.prepare(
				`SELECT
					COUNT(CASE WHEN used = 1 THEN 1 END) AS count,
					MAX(fetched_at) AS latest
				 FROM sources
				 WHERE run_id = ?`
			)
			.get(row.id) as { count: number; latest: string | null } | undefined;
		const crawlPlanSourceStats = this.db
			.prepare(
				`SELECT COUNT(*) AS count, MAX(created_at) AS latest
				 FROM events
				 WHERE run_id = ? AND kind = 'source.discovered'`
			)
			.get(row.id) as { count: number; latest: string | null } | undefined;
		const latestActivityAt = latestIso([
			run.updated_at,
			run.completed_at,
			run.started_at,
			run.queued_at,
			usableSourceStats?.latest ?? sourceStats?.latest,
			crawlPlanSourceStats?.latest,
			...steps.flatMap((step) => [step.completed_at, step.started_at]),
			...toolCalls.flatMap((call) => [call.completed_at, call.started_at])
		]);

		return {
			...run,
			steps: steps.map(runStepDto).reverse(),
			tool_calls: toolCalls.map(toolCallDto).reverse(),
			source_count: (usableSourceStats?.count ?? 0) + (crawlPlanSourceStats?.count ?? 0),
			latest_activity_at: latestActivityAt
		};
	}

	dueJobs(now = nowIso()): NewsroomJobDto[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM jobs
				 WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
				 ORDER BY next_run_at ASC LIMIT 10`
			)
			.all(now) as JobRow[];
		return rows.map(jobDto);
	}

	hasActiveRun(jobId: string): boolean {
		const row = this.db
			.prepare(`SELECT id FROM runs WHERE job_id = ? AND status IN ('queued', 'running') LIMIT 1`)
			.get(jobId);
		return Boolean(row);
	}

	addRunStep(runId: string, stepType: string, label: string, status = 'completed', detail?: unknown): void {
		const now = nowIso();
		const result = this.db
			.prepare(
				`INSERT INTO run_steps (run_id, step_type, label, status, started_at, completed_at, detail_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(runId, stepType, label, status, now, now, detail ? JSON.stringify(detail) : null);
		this.appendEvent({
			workspaceId: this.workspaceIdForRun(runId),
			jobId: this.jobIdForRun(runId),
			runId,
			agent: stepType,
			kind: 'run.step',
			payload: {
				step_id: Number(result.lastInsertRowid),
				step_type: stepType,
				label,
				status,
				detail: detail ?? null
			},
			createdAt: now
		});
	}

	recordToolCall(input: {
		id?: string;
		runId?: string | null;
		name: string;
		args: unknown;
		result?: unknown;
		status: string;
		error?: string | null;
		startedAt?: string;
		completedAt?: string | null;
	}): string {
		const id = input.id || newId('tool');
		const startedAt = input.startedAt || nowIso();
		const completedAt = input.completedAt ?? (input.status === 'running' ? null : nowIso());
		this.db
			.prepare(
				`INSERT INTO tool_calls
				 (id, run_id, name, args_json, result_json, status, started_at, completed_at, error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				input.runId || null,
				input.name,
				JSON.stringify(input.args ?? {}),
				input.result === undefined ? null : JSON.stringify(input.result),
				input.status,
				startedAt,
				completedAt,
				input.error || null
			);
		this.appendEvent({
			workspaceId: input.runId ? this.workspaceIdForRun(input.runId) : DEFAULT_WORKSPACE_ID,
			jobId: input.runId ? this.jobIdForRun(input.runId) : null,
			runId: input.runId || null,
			agent: input.name,
			kind: input.status === 'running' ? 'tool.call.started' : 'tool.call.recorded',
			payload: {
				tool_call_id: id,
				name: input.name,
				status: input.status,
				args: input.args ?? {},
				result: input.result ?? null,
				error: input.error || null
			},
			createdAt: startedAt
		});
		return id;
	}

	updateToolCall(id: string, input: { result?: unknown; status: string; error?: string | null }): void {
		const existing = this.db
			.prepare('SELECT id, run_id, name FROM tool_calls WHERE id = ?')
			.get(id) as Pick<ToolCallRow, 'id' | 'run_id' | 'name'> | undefined;
		const completedAt = nowIso();
		this.db
			.prepare(
				`UPDATE tool_calls SET result_json = ?, status = ?, completed_at = ?, error = ? WHERE id = ?`
			)
			.run(
				input.result === undefined ? null : JSON.stringify(input.result),
				input.status,
				completedAt,
				input.error || null,
				id
			);
		if (existing) {
			this.appendEvent({
				workspaceId: existing.run_id ? this.workspaceIdForRun(existing.run_id) : DEFAULT_WORKSPACE_ID,
				jobId: existing.run_id ? this.jobIdForRun(existing.run_id) : null,
				runId: existing.run_id,
				agent: existing.name,
				kind: input.status === 'failed' ? 'tool.call.failed' : 'tool.call.completed',
				payload: {
					tool_call_id: id,
					name: existing.name,
					status: input.status,
					result: input.result ?? null,
					error: input.error || null
				},
				createdAt: completedAt
			});
		}
	}

	storeSource(input: StoreSourceInput): NewsroomSourceDto {
		const snapshotId = newId('snap');
		const sourceId = newId('src');
		this.db
			.prepare(
				`INSERT INTO source_snapshots
				 (id, url, title, fetched_at, content_text, content_hash, content_type, status_code)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				snapshotId,
				input.url,
				input.title,
				input.fetchedAt,
				input.contentText,
				input.contentHash,
				input.contentType || null,
				input.statusCode || null
			);
		this.db
			.prepare(
				`INSERT INTO sources
				 (id, run_id, job_id, snapshot_id, url, title, fetched_at, snippet, summary, used)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				sourceId,
				input.runId,
				input.jobId,
				snapshotId,
				input.url,
				input.title,
				input.fetchedAt,
				input.snippet,
				input.summary,
				input.used ? 1 : 0
			);
		this.appendEvent({
			workspaceId: this.workspaceIdForRun(input.runId),
			jobId: input.jobId,
			runId: input.runId,
			agent: 'source_monitor',
			kind: 'source.stored',
			payload: {
				source_id: sourceId,
				snapshot_id: snapshotId,
				url: input.url,
				title: input.title,
				fetched_at: input.fetchedAt,
				used: input.used,
				content_type: input.contentType || null,
				status_code: input.statusCode || null,
				...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
				...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
				...(input.archiveSnapshotUrl ? { archive_snapshot_url: input.archiveSnapshotUrl } : {})
			},
			sources: [
				{
					id: sourceId,
					url: input.url,
					title: input.title,
					fetched_at: input.fetchedAt,
					used: input.used,
					...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
					...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
					...(input.archiveSnapshotUrl ? { archive_snapshot_url: input.archiveSnapshotUrl } : {})
				}
			],
			createdAt: nowIso()
		});
		if (input.healthGate) {
			this.appendEvent({
				workspaceId: this.workspaceIdForRun(input.runId),
				jobId: input.jobId,
				runId: input.runId,
				agent: 'source_monitor',
				kind: 'source.health.gate',
				payload: input.healthGate,
				sources: [
					{
						id: sourceId,
						url: input.url,
						title: input.title,
						fetched_at: input.fetchedAt,
						used: input.used
					}
				],
				createdAt: nowIso()
			});
		}
		return this.listSourcesForRun(input.runId).find((source) => source.id === sourceId) as NewsroomSourceDto;
	}

	listSourcesForRun(runId: string): NewsroomSourceDto[] {
		const rows = this.db
			.prepare('SELECT id, run_id, job_id, url, title, fetched_at, snippet, summary, used FROM sources WHERE run_id = ?')
			.all(runId) as SourceRow[];
		return rows.map(sourceDto);
	}

	createReport(input: {
		runId: string;
		jobId: string;
		title: string;
		markdown: string;
		ingestStatus?: NewsroomReportDto['ingest_status'];
		ingestError?: string | null;
	}): NewsroomReportDto {
		const id = newId('report');
		const createdAt = nowIso();
		const ingestStatus = input.ingestStatus || 'not_configured';
		const ingestError = input.ingestError || null;
		this.db
			.prepare(
				`INSERT INTO reports
				 (id, run_id, job_id, title, markdown, created_at, ingest_status, ingest_error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				input.runId,
				input.jobId,
				input.title,
				input.markdown,
				createdAt,
				ingestStatus,
				ingestError
			);
		this.appendEvent({
			workspaceId: this.workspaceIdForRun(input.runId),
			jobId: input.jobId,
			runId: input.runId,
			agent: 'reporter',
			kind: 'report.created',
			payload: {
				report_id: id,
				title: input.title,
				ingest_status: ingestStatus,
				ingest_error: ingestError
			},
			createdAt
		});
		return this.requireReport(id);
	}

	updateReportIngest(id: string, status: NewsroomReportDto['ingest_status'], error: string | null): void {
		const existing = this.db
			.prepare('SELECT id, run_id, job_id FROM reports WHERE id = ?')
			.get(id) as Pick<ReportRow, 'id' | 'run_id' | 'job_id'> | undefined;
		this.db.prepare('UPDATE reports SET ingest_status = ?, ingest_error = ? WHERE id = ?').run(status, error, id);
		if (existing) {
			this.appendEvent({
				workspaceId: this.workspaceIdForRun(existing.run_id),
				jobId: existing.job_id,
				runId: existing.run_id,
				agent: 'reporter',
				kind: 'report.ingest.updated',
				payload: {
					report_id: id,
					ingest_status: status,
					ingest_error: error
				}
			});
		}
	}

	requireReport(id: string): NewsroomReportDto {
		const row = this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
		if (!row) throw new Error('Report not found');
		return reportDto(row);
	}

	listReports(): NewsroomReportDto[] {
		return (this.db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all() as ReportRow[]).map(
			reportDto
		);
	}
}

function requiredText(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} is required`);
	return trimmed;
}

function optionalText(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function requiredMemoryKey<T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
	const key = requiredText(value, label);
	if (!allowed.includes(key)) throw new Error(`Unsupported ${label}: ${key}`);
	return key;
}

function requiredGateType(value: string): NewsroomGateType {
	const type = requiredText(value, 'gate type');
	if (!GATE_TYPES.includes(type as NewsroomGateType)) throw new Error(`Unsupported gate type: ${type}`);
	return type as NewsroomGateType;
}

function requiredGateStatus(value: string): NewsroomGateStatus {
	const status = requiredText(value, 'gate status');
	if (status !== 'open' && status !== 'resolved') throw new Error(`Unsupported gate status: ${status}`);
	return status;
}

function normalizeGateActions(value: string[] | undefined, type: NewsroomGateType): string[] {
	const candidates = value?.length ? value : DEFAULT_GATE_ACTIONS[type];
	const seen = new Set<string>();
	const actions: string[] = [];
	for (const candidate of candidates) {
		const action = optionalText(candidate);
		if (!action || seen.has(action)) continue;
		seen.add(action);
		actions.push(action);
	}
	return actions.length ? actions : [...DEFAULT_GATE_ACTIONS[type]];
}

function normalizeCrawlPlanSeedUrls(input: SaveCrawlPlanVersionInput): string[] {
	const candidates = input.seed_urls?.length ? input.seed_urls : input.seed_url ? [input.seed_url] : [];
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const candidate of candidates) {
		const url = normalizeHttpUrl(candidate, 'seed_url');
		if (seen.has(url)) continue;
		seen.add(url);
		urls.push(url);
	}
	if (urls.length === 0) throw new Error('at least one seed URL is required');
	return urls;
}

function normalizeHttpUrl(value: string, field: string): string {
	const raw = requiredText(value, field);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`${field} must be a valid URL`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`${field} must start with http:// or https://`);
	}
	parsed.hash = '';
	return parsed.toString();
}

function normalizeCrawlPlanBodyStrategy(
	value: NewsroomCrawlPlanArticleBodyStrategy | undefined
): NewsroomCrawlPlanArticleBodyStrategy {
	const strategy = value || 'auto';
	if (!CRAWL_PLAN_BODY_STRATEGIES.includes(strategy)) {
		throw new Error(`Unsupported article body strategy: ${strategy}`);
	}
	return strategy;
}

function normalizeCrawlPlanChangeDetection(
	value: NewsroomCrawlPlanChangeDetection | undefined
): NewsroomCrawlPlanChangeDetection {
	const mode = value || 'hash';
	if (!CRAWL_PLAN_CHANGE_DETECTION.includes(mode)) {
		throw new Error(`Unsupported change detection mode: ${mode}`);
	}
	return mode;
}

function normalizeCrawlPlanStatus(value: NewsroomCrawlPlanStatus | undefined): NewsroomCrawlPlanStatus {
	const status = value || 'pending';
	if (!CRAWL_PLAN_STATUSES.includes(status)) {
		throw new Error(`Unsupported crawl plan status: ${status}`);
	}
	return status;
}

function normalizeCrawlPlanPoliteFetch(
	value: Partial<NewsroomCrawlPlanPoliteFetchOverridesDto> | undefined
): NewsroomCrawlPlanPoliteFetchOverridesDto {
	return {
		respect_robots: value?.respect_robots ?? DEFAULT_CRAWL_PLAN_POLITE_FETCH.respect_robots,
		robots_override: value?.robots_override ?? DEFAULT_CRAWL_PLAN_POLITE_FETCH.robots_override,
		host_delay_ms: clampNonNegativeInteger(value?.host_delay_ms, DEFAULT_CRAWL_PLAN_POLITE_FETCH.host_delay_ms),
		failure_budget: clampPositiveInteger(value?.failure_budget, DEFAULT_CRAWL_PLAN_POLITE_FETCH.failure_budget),
		archive_web: value?.archive_web ?? DEFAULT_CRAWL_PLAN_POLITE_FETCH.archive_web
	};
}

function normalizeCrawlPlanCandidateLinks(value: unknown[] | undefined): NewsroomCrawlPlanCandidateLinkDto[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		const raw = objectValue(candidate);
		if (!raw) return [];
		const title = optionalText(stringValue(raw.title));
		const url = normalizeOptionalHttpUrl(stringValue(raw.url) ?? undefined);
		if (!title || !url) return [];
		return [
			{
				title,
				url,
				reason: optionalText(stringValue(raw.reason)) || 'Crawl plan candidate',
				score: clampNonNegativeInteger(numberValue(raw.score) ?? undefined, 0)
			}
		];
	});
}

function normalizeOptionalHttpUrl(value: string | undefined): string | null {
	try {
		return value ? normalizeHttpUrl(value, 'candidate url') : null;
	} catch {
		return null;
	}
}

function clampNonNegativeInteger(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.trunc(value as number));
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.trunc(value as number));
}

function addNullableFilter(
	conditions: string[],
	params: unknown[],
	column: 'story_id' | 'job_id' | 'run_id',
	value: string | null | undefined
): void {
	if (value === undefined) return;
	if (value === null) {
		conditions.push(`${column} IS NULL`);
		return;
	}
	conditions.push(`${column} = ?`);
	params.push(requiredText(value, column));
}

function clampEventLimit(value: number | undefined): number {
	if (!Number.isFinite(value)) return 100;
	return Math.max(1, Math.min(500, Math.trunc(value as number)));
}

function clampGateLimit(value: number | undefined): number {
	if (!Number.isFinite(value)) return 50;
	return Math.max(1, Math.min(200, Math.trunc(value as number)));
}

function clampGatePriority(value: number | undefined): number {
	if (!Number.isFinite(value)) return 3;
	return Math.max(1, Math.min(5, Math.trunc(value as number)));
}

function stringifyJson(value: unknown): string {
	const encoded = JSON.stringify(value);
	return encoded === undefined ? 'null' : encoded;
}

function parseEventJson(value: string | null, fallback: NewsroomEventJson): NewsroomEventJson {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as NewsroomEventJson;
	} catch {
		return fallback;
	}
}

function parseEventSources(value: string | null): NewsroomEventJson[] {
	const parsed = parseEventJson(value, []);
	return Array.isArray(parsed) ? parsed : [];
}

function parseGateActions(value: string | null): string[] {
	const parsed = parseEventJson(value, []);
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((candidate) => (typeof candidate === 'string' && candidate.trim() ? [candidate.trim()] : []));
}

function houseMemoryDefaults(): Record<string, NewsroomEventJson> {
	return {
		style_guide: '',
		banned_phrases: [],
		libel_patterns: [],
		gazetteer: {},
		model_preferences: {},
		beats: []
	};
}

function scopedMemoryCurrent(
	entries: MemoryEntryDto[],
	requiredKeys: readonly string[]
): Record<string, NewsroomEventJson[]> {
	const current = Object.fromEntries(requiredKeys.map((key) => [key, []])) as Record<string, NewsroomEventJson[]>;
	for (const entry of entries) {
		if (!current[entry.key]) current[entry.key] = [];
		current[entry.key].push(entry.value);
	}
	return current;
}

function memoryEntryDto(row: MemoryEntryRow): MemoryEntryDto {
	return {
		id: row.id,
		workspace_id: row.workspace_id || DEFAULT_WORKSPACE_ID,
		tier: row.tier,
		scope_id: row.scope_id,
		key: row.key,
		kind: row.kind,
		value: parseEventJson(row.value_json, null),
		actor: row.actor,
		created_at: row.created_at
	};
}

function crawlPlanVersionFromMemoryEntry(entry: MemoryEntryDto): NewsroomCrawlPlanVersionDto | null {
	const raw = objectValue(entry.value);
	if (!raw) return null;
	const id = stringValue(raw.id);
	const beatId = stringValue(raw.beat_id);
	const version = numberValue(raw.version);
	if (!id || !beatId || !version) return null;
	return {
		id,
		beat_id: beatId,
		version,
		seed_urls: stringArray(raw.seed_urls),
		link_follow_rule: stringValue(raw.link_follow_rule) || '',
		article_body_strategy: normalizeCrawlPlanBodyStrategy(
			stringValue(raw.article_body_strategy) as NewsroomCrawlPlanArticleBodyStrategy | undefined
		),
		polling_cadence: stringValue(raw.polling_cadence) || 'inherit beat schedule',
		jitter_ms: numberValue(raw.jitter_ms) ?? 0,
		change_detection: normalizeCrawlPlanChangeDetection(
			stringValue(raw.change_detection) as NewsroomCrawlPlanChangeDetection | undefined
		),
		status: stringValue(raw.status)
			? normalizeCrawlPlanStatus(stringValue(raw.status) as NewsroomCrawlPlanStatus | undefined)
			: undefined,
		polite_fetch: normalizeCrawlPlanPoliteFetch(
			objectValue(raw.polite_fetch) as Partial<NewsroomCrawlPlanPoliteFetchOverridesDto> | undefined
		),
		candidate_links: normalizeCrawlPlanCandidateLinks(
			Array.isArray(raw.candidate_links) ? (raw.candidate_links as unknown as NewsroomCrawlPlanCandidateLinkDto[]) : []
		),
		created_by: stringValue(raw.created_by) || entry.actor,
		created_at: stringValue(raw.created_at) || entry.created_at,
		source_memory_entry_id: stringValue(raw.source_memory_entry_id) || entry.id,
		supersedes_version: numberValue(raw.supersedes_version)
	};
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

function numberValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		const text = stringValue(candidate);
		return text ? [text] : [];
	});
}

function eventDto(row: EventRow): NewsroomEventDto {
	return {
		id: row.id,
		workspace_id: row.workspace_id,
		story_id: row.story_id,
		job_id: row.job_id,
		run_id: row.run_id,
		agent: row.agent,
		kind: row.kind,
		payload: parseEventJson(row.payload_json, {}),
		sources: parseEventSources(row.sources_json),
		parent_event_id: row.parent_event_id,
		cost_metadata: parseEventJson(row.cost_metadata_json, null),
		created_at: row.created_at
	};
}

function gateDto(row: GateRow): NewsroomGateDto {
	const resolution =
		row.status === 'resolved' && row.resolution_action && row.resolved_by && row.resolved_at
			? {
					action: row.resolution_action,
					notes: row.resolution_notes,
					payload: parseEventJson(row.resolution_payload_json, null),
					actor: row.resolved_by,
					resolved_at: row.resolved_at,
					event_id: row.resolution_event_id
				}
			: null;
	return {
		id: row.id,
		workspace_id: row.workspace_id,
		story_id: row.story_id,
		job_id: row.job_id,
		run_id: row.run_id,
		type: row.type,
		title: row.title,
		summary: row.summary,
		status: row.status,
		priority: row.priority,
		payload: parseEventJson(row.payload_json, {}),
		actions: parseGateActions(row.actions_json),
		created_by: row.created_by,
		created_at: row.created_at,
		resolution
	};
}

function jobDto(row: JobRow): NewsroomJobDto {
	const state = row.enabled ? row.last_status || 'scheduled' : 'paused';
	return {
		id: row.id,
		workspace_id: row.workspace_id || DEFAULT_WORKSPACE_ID,
		name: row.name,
		title: row.name,
		description: row.description,
		prompt: row.prompt,
		schedule: row.schedule,
		cron: row.schedule,
		schedule_display: row.schedule,
		enabled: Boolean(row.enabled),
		state,
		next_run_at: row.next_run_at,
		last_run_at: row.last_run_at,
		last_status: row.last_status,
		last_error: row.last_error,
		last_delivery_error: row.last_delivery_error,
		deliver: row.deliver,
		output_format: row.output_format,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function workspaceIdForJob(job: Pick<NewsroomJobDto, 'workspace_id'>): string {
	return job.workspace_id || DEFAULT_WORKSPACE_ID;
}

function runDto(row: RunRow): NewsroomRunDto {
	return {
		id: row.id,
		job_id: row.job_id,
		job_name: row.job_name ?? null,
		status: row.status,
		trigger: row.trigger,
		queued_at: row.queued_at,
		started_at: row.started_at,
		completed_at: row.completed_at,
		updated_at: row.updated_at,
		elapsed_ms: row.elapsed_ms,
		last_error: row.last_error
	};
}

function runStepDto(row: RunStepRow): NewsroomRunStepDto {
	return {
		id: row.id,
		run_id: row.run_id,
		step_type: row.step_type,
		label: row.label,
		status: row.status,
		started_at: row.started_at,
		completed_at: row.completed_at
	};
}

function toolCallDto(row: ToolCallRow): NewsroomToolCallDto {
	return {
		id: row.id,
		run_id: row.run_id,
		name: row.name,
		status: row.status,
		started_at: row.started_at,
		completed_at: row.completed_at,
		error: row.error
	};
}

function latestIso(values: Array<string | null | undefined>): string | null {
	let latest = 0;
	let latestValue: string | null = null;
	for (const value of values) {
		if (!value) continue;
		const time = Date.parse(value);
		if (!Number.isFinite(time) || time < latest) continue;
		latest = time;
		latestValue = value;
	}
	return latestValue;
}

function sourceDto(row: SourceRow): NewsroomSourceDto {
	return {
		id: row.id,
		run_id: row.run_id,
		job_id: row.job_id,
		url: row.url,
		title: row.title,
		fetched_at: row.fetched_at,
		snippet: row.snippet,
		summary: row.summary,
		used: Boolean(row.used)
	};
}

function reportDto(row: ReportRow): NewsroomReportDto {
	return {
		id: row.id,
		run_id: row.run_id,
		job_id: row.job_id,
		title: row.title,
		markdown: row.markdown,
		created_at: row.created_at,
		ingest_status: row.ingest_status,
		ingest_error: row.ingest_error
	};
}
