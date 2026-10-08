/** The saved transport names remain compatible; there is one NewsCraft runtime. */
export const NEWSCRAFT_AGENT_SERVICE = 'newscraft-agent';
export const HERMES_TOOLSET = NEWSCRAFT_AGENT_SERVICE;

export type PublicPlanStepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface PublicPlanStep {
	id: string;
	label: string;
	status: PublicPlanStepStatus;
	detail?: string;
	requirementId?: string;
	phase?: 'discovery' | 'official' | 'corroboration';
}

export interface PublicPlanRequirementCoverage {
	requirement_id: string;
	label: string;
	requested_count: number;
	accepted_count: number;
	state: string;
	gaps: string[];
	likely_to_improve: boolean;
	executed_actions: number;
	skipped_actions: number;
	budget_exhausted: boolean;
}

/** Public work commitments, never the model's private reasoning. */
export interface PublicAgentPlan {
	source: 'model' | 'router';
	steps: PublicPlanStep[];
	requirementCoverage?: PublicPlanRequirementCoverage[];
	assignmentStatus?: string;
}

/** A deliberately authored, short explanation of a user-visible choice. */
export interface PublicAgentDecision {
	id: string;
	summary: string;
	stepId?: string;
}

export const NEWSCRAFT_PUBLIC_ACTIVITY = {
	plan: { custom: 'newscraft.plan', event: 'agent.plan' },
	decision: { custom: 'newscraft.decision', event: 'agent.decision' }
} as const;

function activityObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function activityText(value: unknown, limit: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	const text = value
		.replace(/[\u0000-\u001f\u007f]/gu, ' ')
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
		.replace(/\s+/gu, ' ')
		.trim();
	return text ? text.slice(0, limit) : undefined;
}

function activityId(value: unknown): string | undefined {
	return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,96}$/u.test(value)
		? value
		: undefined;
}

function activityCount(value: unknown): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? Math.min(value, 10_000)
		: 0;
}

/** Project only named public fields; arbitrary CUSTOM/reasoning content is discarded. */
export function normalizePublicAgentPlan(value: unknown): PublicAgentPlan | null {
	const payload = activityObject(value);
	if (!payload || !Array.isArray(payload.steps)) return null;
	const steps = new Map<string, PublicPlanStep>();
	for (const raw of payload.steps.slice(0, 12)) {
		const row = activityObject(raw);
		const id = activityId(row?.id);
		const label = activityText(row?.label, 160);
		if (!row || !id || !label) continue;
		const status = ['pending', 'running', 'ok', 'failed', 'skipped'].includes(String(row.status))
			? row.status as PublicPlanStepStatus : 'pending';
		const detail = activityText(row.detail, 240);
		const requirementId = activityId(row.requirementId ?? row.requirement_id);
		const phase = ['discovery', 'official', 'corroboration'].includes(String(row.phase))
			? row.phase as PublicPlanStep['phase'] : undefined;
		steps.set(id, { id, label, status, ...(detail ? { detail } : {}),
			...(requirementId ? { requirementId } : {}), ...(phase ? { phase } : {}) });
	}
	if (!steps.size) return null;
	const rawCoverage = payload.requirementCoverage ?? payload.requirement_coverage;
	const requirementCoverage: PublicPlanRequirementCoverage[] = [];
	if (Array.isArray(rawCoverage)) {
		for (const raw of rawCoverage.slice(0, 12)) {
			const row = activityObject(raw);
			const id = activityId(row?.requirement_id ?? row?.requirementId);
			const label = activityText(row?.label, 160);
			if (!row || !id || !label) continue;
			requirementCoverage.push({ requirement_id: id, label,
				requested_count: activityCount(row.requested_count ?? row.requestedCount),
				accepted_count: activityCount(row.accepted_count ?? row.acceptedCount),
				state: activityText(row.state, 32) || 'pending',
				gaps: Array.isArray(row.gaps) ? row.gaps.slice(0, 12)
					.map(gap => activityText(gap, 160)).filter((gap): gap is string => !!gap) : [],
				likely_to_improve: row.likely_to_improve === true || row.likelyToImprove === true,
				executed_actions: activityCount(row.executed_actions ?? row.executedActions),
				skipped_actions: activityCount(row.skipped_actions ?? row.skippedActions),
				budget_exhausted: row.budget_exhausted === true || row.budgetExhausted === true });
		}
	}
	const assignmentStatus = activityText(payload.assignmentStatus ?? payload.assignment_status, 32);
	return { source: payload.source === 'model' ? 'model' : 'router', steps: [...steps.values()],
		...(requirementCoverage.length ? { requirementCoverage } : {}),
		...(assignmentStatus ? { assignmentStatus } : {}) };
}

export function normalizePublicAgentDecision(value: unknown): PublicAgentDecision | null {
	const payload = activityObject(value);
	const id = activityId(payload?.id);
	const summary = activityText(payload?.summary, 320);
	if (!payload || !id || !summary) return null;
	const stepId = activityId(payload.stepId ?? payload.step_id);
	return { id, summary, ...(stepId ? { stepId } : {}) };
}

export interface HermesContextEntry {
	description: string;
	value: string;
}

export interface HermesAguiMessage {
	id: string;
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | Array<Record<string, unknown>>;
	toolCallId?: string;
	toolCalls?: Array<Record<string, unknown>>;
}

export interface HermesForwardedProps {
	source: 'newscraft';
	operation: 'chat' | 'send' | 'retry' | 'regenerate' | 'resume' | 'transform';
	citationStartNumber: number;
	webExtractConfigured: boolean;
	retrievalVerificationTool: 'verify_this_lead';
	retrievalBackend: 'newscraft-local';
	retrievalMaxUrls: number;
	archiveFallback: 'wayback';
	stateWriterTools: HermesStateWriterTool[];
}

export interface HermesStateWriterTool {
	name: string;
	stateKey: string;
	arg: string;
	mode: 'append' | 'replace';
	description: string;
	parameters: Record<string, unknown>;
}

export interface HermesRunInput {
	threadId: string;
	runId: string;
	/** Server-generated correlation id. Never accept this from browser input. */
	trace_id?: string;
	state: { newscraftSources: Array<Record<string, unknown>> };
	messages: HermesAguiMessage[];
	tools: [];
	context: HermesContextEntry[];
	forwardedProps: HermesForwardedProps;
}

export const HERMES_AGUI_EVENT_TYPES = {
	runStarted: 'RUN_STARTED',
	runFinished: 'RUN_FINISHED',
	runError: 'RUN_ERROR',
	textMessageStart: 'TEXT_MESSAGE_START',
	textMessageContent: 'TEXT_MESSAGE_CONTENT',
	textMessageEnd: 'TEXT_MESSAGE_END',
	toolCallStart: 'TOOL_CALL_START',
	toolCallArgs: 'TOOL_CALL_ARGS',
	toolCallEnd: 'TOOL_CALL_END',
	toolCallResult: 'TOOL_CALL_RESULT',
	stateSnapshot: 'STATE_SNAPSHOT',
	custom: 'CUSTOM'
} as const;
