// Cross-component chat session state. Holds the in-flight AbortController so
// keyboard shortcuts (Esc) can cancel a stream the composer started.
//
// Also holds the ephemeral tool-progress strip + the prompt-reuse handoff used
// by the ↑ keyboard shortcut to recall the previous user message.

import type { CitationRecord } from '@newscraft/shared';

export type PlanStepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface PlanStepSource {
	url: string;
	title: string;
}

export interface PlanStep {
	id: string;
	label: string;
	status: PlanStepStatus;
	detail?: string;
	/** Sources attributed to this step, in arrival order. */
	sources?: PlanStepSource[];
}

export interface ActivePlan {
	source: 'model' | 'router';
	steps: PlanStep[];
}

interface ToolProgress {
	id: string;
	name: string;
	emoji?: string;
	startedAt: number;
	endedAt?: number;
	detail?: string;
	url?: string;
	title?: string;
	status?: string;
	arguments?: unknown;
	result?: unknown;
	transcript?: string;
}

interface ToolHistoryEntry {
	id: string;
	name: string;
	startedAt: number;
	finishedAt: number;
	endedAt?: number;
	durationMs?: number;
	detail?: string;
	url?: string;
	title?: string;
	status?: string;
	arguments?: unknown;
	result?: unknown;
	transcript?: string;
}

type ToolUpdate = Omit<ToolProgress, 'startedAt'> & { startedAt?: number; durationMs?: number };

interface SourceProgress {
	id: string;
	url: string;
	title: string;
	status: 'queued' | 'reading' | 'used' | 'skipped' | 'error' | string;
	domain: string;
	detail?: string;
	updatedAt: number;
	firstSeenAt?: number;
	lastSeenAt?: number;
	used?: boolean;
	/** The plan step id this source is attributed to, if any. */
	stepId?: string;
}

class ChatSession {
	abort = $state<AbortController | null>(null);
	abortIntent = $state<'stop' | 'partial' | null>(null);
	tools = $state<ToolProgress[]>([]);
	sources = $state<SourceProgress[]>([]);
	citations = $state<CitationRecord[]>([]);
	// Names of tools that completed during the current run. Cleared on the
	// next startStream so each turn shows its own summary; powers the
	// "Sources checked" recap that replaces the live activity component.
	toolHistory = $state<ToolHistoryEntry[]>([]);
	streamStartedAt = $state<number | null>(null);
	toolUpdatedAt = $state<number | null>(null);
	hasAssistantOutput = $state(false);
	activityConversationId = $state<string | null>(null);
	streaming = $state(false);
	editRequest = $state<string | null>(null); // populated by ↑; consumed by Composer as prompt reuse
	lastUserContent = $state<string | null>(null); // set by the active conversation page; read by ↑ handler
	/** Current agent plan. Set when the first agent.plan frame arrives; updated on each step-status change. */
	plan = $state<ActivePlan | null>(null);

	startStream(conversationId?: string): AbortController {
		// If a stream is already in flight, abort it so the next one can take
		// over cleanly. The previous runStream's finally clause will detect
		// that the active controller has changed and skip the state reset.
		if (this.abort && !this.abort.signal.aborted) {
			this.abort.abort();
		}
		const c = new AbortController();
		this.abort = c;
		this.abortIntent = null;
		this.streaming = true;
		this.tools = [];
		this.sources = [];
		this.citations = [];
		this.toolHistory = [];
		this.plan = null;
		this.streamStartedAt = Date.now();
		this.toolUpdatedAt = null;
		this.hasAssistantOutput = false;
		this.activityConversationId = conversationId ?? null;
		return c;
	}

	endStream() {
		this.abort = null;
		this.abortIntent = null;
		this.streaming = false;
		this.tools = [];
		this.streamStartedAt = null;
		this.toolUpdatedAt = null;
		// Keep toolHistory so the recap stays visible against the latest
		// assistant message until the next stream begins.
	}

	cancel(intent: 'stop' | 'partial' = 'stop') {
		this.abortIntent = intent;
		if (this.abort) {
			this.abort.abort();
		}
		this.tools = [];
	}

	noteAssistantOutput(piece: string) {
		if (piece.trim()) this.hasAssistantOutput = true;
	}

	setPlan(plan: ActivePlan) {
		// Preserve per-step sources accumulated so far when the plan snapshot arrives.
		if (this.plan) {
			const existingSources = new Map(this.plan.steps.map((s) => [s.id, s.sources ?? []]));
			this.plan = {
				...plan,
				steps: plan.steps.map((s) => ({
					...s,
					sources: existingSources.get(s.id) ?? s.sources ?? []
				}))
			};
		} else {
			this.plan = plan;
		}
	}

	setCitations(citations: CitationRecord[]) {
		this.citations = citations.map((citation) => ({ ...citation }));
	}

	/** Attach a source to a plan step by stepId. Called from pushSource when stepId is present. */
	private addSourceToStep(stepId: string, source: PlanStepSource) {
		if (!this.plan) return;
		this.plan = {
			...this.plan,
			steps: this.plan.steps.map((s) => {
				if (s.id !== stepId) return s;
				const existing = s.sources ?? [];
				// Deduplicate by URL.
				if (existing.some((e) => e.url === source.url)) return s;
				return { ...s, sources: [...existing, source] };
			})
		};
	}

	pushTool(t: ToolUpdate) {
		this.toolUpdatedAt = Date.now();
		const existing = this.tools.find((tool) => tool.id === t.id);
		const next: ToolProgress = {
			...existing,
			...t,
			name: t.name || existing?.name || t.id,
			startedAt: existing?.startedAt ?? t.startedAt ?? Date.now()
		};
		if (existing) {
			this.tools = this.tools.map((tool) => (tool.id === t.id ? next : tool));
		} else {
			this.tools = [...this.tools, next];
		}
		if (next.url) {
			this.pushSource({
				id: next.url,
				url: next.url,
				title: next.title || next.url,
				status: normalizeSourceStatus(next.status),
				domain: domainOf(next.url),
				detail: next.detail,
				updatedAt: Date.now(),
				used: toolUpdateUsesSource(next)
			});
		}
	}

	clearTool(id: string, update?: Partial<ToolUpdate>) {
		this.toolUpdatedAt = Date.now();
		const finished = this.tools.find((t) => t.id === id);
		this.tools = this.tools.filter((t) => t.id !== id);
		const merged: ToolProgress = {
			...(finished ?? {
				id,
				name: update?.name ?? id,
				startedAt: update?.startedAt ?? Date.now()
			}),
			...update,
			id,
			name: update?.name ?? finished?.name ?? id,
			startedAt: finished?.startedAt ?? update?.startedAt ?? Date.now()
		};
		const finishedAt = update?.endedAt ?? merged.endedAt ?? Date.now();
		const status = normalizeDoneStatus(update?.status ?? merged.status);
		const entry: ToolHistoryEntry = {
			id: merged.id,
			name: merged.name,
			startedAt: merged.startedAt,
			finishedAt,
			endedAt: finishedAt,
			durationMs: update?.durationMs ?? (finishedAt ? finishedAt - merged.startedAt : undefined),
			detail: update?.detail ?? merged.detail,
			url: update?.url ?? merged.url,
			title: update?.title ?? merged.title,
			status,
			arguments: update?.arguments ?? merged.arguments,
			result: update?.result ?? merged.result,
			transcript: update?.transcript ?? merged.transcript
		};
		this.toolHistory = [...this.toolHistory.filter((t) => t.id !== id), entry];
	}

	pushSource(source: SourceProgress) {
		const normalizedStatus = normalizeSourceStatus(source.status);
		const normalizedSource = { ...source, status: normalizedStatus };
		const byUrl = this.sources.find((s) => s.url === source.url || s.id === source.id);
		const used = source.used ?? sourceStatusIsUsed(normalizedStatus);
		if (byUrl) {
			this.sources = this.sources.map((s) =>
				s.url === source.url || s.id === source.id
					? {
							...s,
							...normalizedSource,
							id: s.id,
							firstSeenAt: s.firstSeenAt ?? source.firstSeenAt ?? source.updatedAt,
							lastSeenAt: source.lastSeenAt ?? source.updatedAt,
							used: Boolean(s.used || used)
						}
					: s
			);
		} else {
			this.sources = [
				...this.sources,
				{
					...normalizedSource,
					firstSeenAt: source.firstSeenAt ?? source.updatedAt,
					lastSeenAt: source.lastSeenAt ?? source.updatedAt,
					used
				}
			].slice(-8);
		}
		// Attach source to its plan step if a stepId is present.
		if (source.stepId) {
			this.addSourceToStep(source.stepId, { url: source.url, title: source.title });
		}
	}

	requestEdit(content: string) {
		this.editRequest = content;
	}

	consumeEdit(): string | null {
		const v = this.editRequest;
		this.editRequest = null;
		return v;
	}
}

export const chat = new ChatSession();

function normalizeSourceStatus(status: string | undefined): SourceProgress['status'] {
	const value = (status || 'reading').toLowerCase();
	if (['done', 'complete', 'completed', 'success', 'ok'].includes(value)) return 'used';
	if (['start', 'started', 'running', 'open', 'fetch'].includes(value)) return 'reading';
	return value;
}

function sourceStatusIsUsed(status: string | undefined): boolean {
	const value = (status || '').toLowerCase();
	if (['queued', 'pending', 'discovered', 'result', 'search_result', 'skipped', 'error'].includes(value)) {
		return false;
	}
	return [
		'start',
		'started',
		'open',
		'opened',
		'fetch',
		'fetched',
		'reading',
		'read',
		'used',
		'done',
		'ok',
		'complete',
		'completed',
		'success'
	].includes(value);
}

function toolUpdateUsesSource(tool: ToolUpdate): boolean {
	const name = (tool.name || '').toLowerCase();
	if (/browse|browser|fetch|read|open|http|url|page|navigate/.test(name)) return true;
	return sourceStatusIsUsed(tool.status);
}

function normalizeDoneStatus(status: string | undefined): string {
	const value = (status || 'ok').toLowerCase();
	if (['done', 'complete', 'completed', 'success'].includes(value)) return 'ok';
	if (['error', 'errored', 'failure'].includes(value)) return 'failed';
	return value;
}

function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}
