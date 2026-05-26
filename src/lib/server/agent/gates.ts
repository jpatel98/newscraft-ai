import type {
	EditorialEvent,
	EditorialGate,
	EditorialGateStatus,
	EditorialGateType
} from '$lib/types';
import { agentFetch } from './transport';

export const DEMO_GATE_TYPES: EditorialGateType[] = [
	'pitch',
	'verification',
	'draft_review',
	'legal_style',
	'publish',
	'crawl_plan',
	'source_health',
	'budget'
];

const DEMO_GATE_KEY = 'jig-136-placeholder-open-gate';

interface ResolveEditorialGateInput {
	action: string;
	notes?: string | null;
}

export async function ensureDemoGate(accountId: string): Promise<EditorialGate[]> {
	const workspaceId = workspaceIdForAccount(accountId);
	const gates = await listEditorialGates(accountId, 'all');
	const openDemoGate = gates.find((gate) => gate.status === 'open' && gateDemoKey(gate) === DEMO_GATE_KEY);
	if (!openDemoGate) {
		await gatewayJson<{ gate: unknown }>('/api/gates', {
			method: 'POST',
			body: JSON.stringify({
				workspace_id: workspaceId,
				story_id: 'demo-open-gate',
				type: 'pitch',
				title: 'Review the placeholder pitch gate',
				summary: 'Resolve this demo gate to verify editor decisions write to the live event feed.',
				priority: 2,
				actions: ['accept', 'hold', 'spike'],
				created_by: 'assignment_desk',
				payload: {
					demo_key: DEMO_GATE_KEY,
					issue: 'JIG-136',
					supported_gate_types: DEMO_GATE_TYPES
				}
			})
		});
	}
	return listEditorialGates(accountId, 'open');
}

export async function listEditorialGates(
	accountId: string,
	status: EditorialGateStatus | 'all' = 'open'
): Promise<EditorialGate[]> {
	const params = new URLSearchParams({
		workspace_id: workspaceIdForAccount(accountId),
		status,
		limit: '50'
	});
	const body = await gatewayJson<{ gates?: unknown[] }>(`/api/gates?${params.toString()}`);
	return (body.gates ?? []).map(normalizeGate).filter((gate): gate is EditorialGate => Boolean(gate));
}

export async function listEditorialEvents(accountId: string): Promise<EditorialEvent[]> {
	const params = new URLSearchParams({
		workspace_id: workspaceIdForAccount(accountId),
		limit: '50'
	});
	const body = await gatewayJson<{ events?: unknown[] }>(`/api/events?${params.toString()}`);
	return (body.events ?? []).map(normalizeEvent).filter((event): event is EditorialEvent => Boolean(event));
}

export async function resolveEditorialGate(
	accountId: string,
	id: string,
	input: ResolveEditorialGateInput
): Promise<{ gate: EditorialGate; event: EditorialEvent }> {
	const gate = await getEditorialGate(id);
	if (gate.workspaceId !== workspaceIdForAccount(accountId)) throw new Error('Gate not found');
	const body = await gatewayJson<{ gate: unknown; event: unknown }>(`/api/gates/${encodeURIComponent(id)}/resolve`, {
		method: 'POST',
		body: JSON.stringify({
			action: input.action,
			notes: input.notes ?? null,
			actor: 'editor'
		})
	});
	const resolvedGate = normalizeGate(body.gate);
	const event = normalizeEvent(body.event);
	if (!resolvedGate || !event) throw new Error('Agent gateway returned an invalid gate resolution');
	return { gate: resolvedGate, event };
}

async function getEditorialGate(id: string): Promise<EditorialGate> {
	const body = await gatewayJson<{ gate: unknown }>(`/api/gates/${encodeURIComponent(id)}`);
	const gate = normalizeGate(body.gate);
	if (!gate) throw new Error('Gate not found');
	return gate;
}

async function gatewayJson<T>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await agentFetch(path, init);
	if (!response.ok) throw new Error(`Agent ${response.status}: ${await response.text()}`);
	return response.json() as Promise<T>;
}

function workspaceIdForAccount(accountId: string): string {
	return `account:${accountId}`;
}

function gateDemoKey(gate: EditorialGate): string | null {
	const payload = objectValue(gate.payload);
	return stringValue(payload?.demo_key);
}

function normalizeGate(value: unknown): EditorialGate | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const id = stringValue(raw.id);
	const workspaceId = stringValue(raw.workspace_id);
	const type = gateTypeValue(raw.type);
	const status = gateStatusValue(raw.status);
	if (!id || !workspaceId || !type || !status) return null;
	return {
		id,
		workspaceId,
		storyId: stringValue(raw.story_id),
		jobId: stringValue(raw.job_id),
		runId: stringValue(raw.run_id),
		type,
		title: stringValue(raw.title) || 'Open gate',
		summary: stringValue(raw.summary) || '',
		status,
		priority: numberValue(raw.priority) ?? 3,
		payload: raw.payload ?? null,
		actions: stringArray(raw.actions),
		createdBy: stringValue(raw.created_by) || 'assignment_desk',
		createdAt: stringValue(raw.created_at) || new Date().toISOString(),
		resolution: normalizeResolution(raw.resolution)
	};
}

function normalizeResolution(value: unknown): EditorialGate['resolution'] {
	const raw = objectValue(value);
	if (!raw) return null;
	const action = stringValue(raw.action);
	const actor = stringValue(raw.actor);
	const resolvedAt = stringValue(raw.resolved_at);
	if (!action || !actor || !resolvedAt) return null;
	return {
		action,
		notes: stringValue(raw.notes),
		payload: raw.payload ?? null,
		actor,
		resolvedAt,
		eventId: stringValue(raw.event_id)
	};
}

function normalizeEvent(value: unknown): EditorialEvent | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const id = stringValue(raw.id);
	const workspaceId = stringValue(raw.workspace_id);
	const kind = stringValue(raw.kind);
	if (!id || !workspaceId || !kind) return null;
	return {
		id,
		workspaceId,
		storyId: stringValue(raw.story_id),
		jobId: stringValue(raw.job_id),
		runId: stringValue(raw.run_id),
		agent: stringValue(raw.agent) || 'agent',
		kind,
		payload: raw.payload ?? null,
		sources: Array.isArray(raw.sources) ? raw.sources : [],
		parentEventId: stringValue(raw.parent_event_id),
		costMetadata: raw.cost_metadata ?? null,
		createdAt: stringValue(raw.created_at) || new Date().toISOString()
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

function gateTypeValue(value: unknown): EditorialGateType | null {
	const type = stringValue(value);
	return DEMO_GATE_TYPES.includes(type as EditorialGateType) ? (type as EditorialGateType) : null;
}

function gateStatusValue(value: unknown): EditorialGateStatus | null {
	const status = stringValue(value);
	return status === 'open' || status === 'resolved' ? status : null;
}
