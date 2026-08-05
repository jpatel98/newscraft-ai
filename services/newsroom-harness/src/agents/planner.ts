import type { RouteDecision } from './router.js';
import { NEWSROOM_TOOL_NAMES } from './router.js';
import { completeProviderText, type ModelProvider } from '../util/openai-complete.js';
import { NEWSROOM_CHARTER } from './roles.js';
import { formatNewsroomTemporalContext, type NewsroomTemporalContext } from './time-context.js';
import { formatResearchRequestContract, type ResearchRequestContract } from '@newscraft/shared';
import type { ContractSatisfaction } from './contract-satisfaction.js';
import type { NewsroomPromptLayers } from './prompt-stack.js';
import type { NewsroomSkillId } from './skills.js';

/**
 * Legacy planning helpers turn a newsroom request into an explicit, bounded
 * list of tool steps. Normal runs use the bounded loop controller below;
 * complete-plan planning and the regex router remain offline/failure fallbacks
 * with concrete per-step inputs and human-facing progress labels.
 */

export interface PlannedStep {
	tool: string;
	input: string;
	label: string;
	laneId?: string;
	lanePurpose?: string;
}

export interface ResearchPlan {
	steps: PlannedStep[];
	reason: string;
	source: 'model' | 'router';
}

export type LoopAction =
	| {
			kind: 'research';
			tool: string;
			input: string;
			label: string;
			skill?: NewsroomSkillId;
			parallel?: boolean;
			laneId?: string;
			lanePurpose?: string;
	  }
	| {
			kind: 'synthesize';
			reason?: string;
	  };

export interface LoopDecision {
	actions: LoopAction[];
	reason: string;
	source: 'model' | 'router';
}

export interface LoopDecisionRequest {
	request: string;
	route: RouteDecision;
	tools: PlannerToolInfo[];
	skills: Array<{ id: NewsroomSkillId; summary: string }>;
	promptLayers: NewsroomPromptLayers;
	evaluation: ContractSatisfaction;
	iteration: number;
	maxIterations: number;
	maxActions: number;
	attempted: ReadonlySet<string>;
	apiKey: string;
	provider?: ModelProvider;
	model: string;
	reasoningEffort?: 'low' | 'medium' | 'high';
	signal?: AbortSignal;
}

export type LoopDecisionFn = (request: LoopDecisionRequest) => Promise<LoopDecision>;

export interface PlannerToolInfo {
	name: string;
	when_to_use: string;
}

export interface PlannerMonitorInfo {
	name: string;
	tags: string[];
}

export interface PlannerRequest {
	prompt: string;
	route: RouteDecision;
	tools: PlannerToolInfo[];
	sourceMonitors: PlannerMonitorInfo[];
	maxSteps: number;
	apiKey: string;
	provider?: ModelProvider;
	model: string;
	reasoningEffort?: 'low' | 'medium' | 'high';
	signal?: AbortSignal;
	temporalContext: NewsroomTemporalContext;
	researchContract?: ResearchRequestContract;
}

export type PlannerFn = (request: PlannerRequest) => Promise<ResearchPlan>;

const MAX_PLAN_STEPS = 4;
const MAX_LOOP_ACTIONS = 2;

export async function planResearchSteps(request: PlannerRequest): Promise<ResearchPlan> {
	const raw = await completeProviderText({
		provider: request.provider,
		apiKey: request.apiKey,
		model: request.model,
		input: plannerInput(request),
		reasoningEffort: request.reasoningEffort || 'low',
		maxOutputTokens: 600,
		disableSearch: true,
		signal: request.signal
	});
	return parseResearchPlan(raw, request);
}

export function parseResearchPlan(
	raw: string,
	request: Pick<PlannerRequest, 'tools' | 'maxSteps' | 'researchContract'>
): ResearchPlan {
	const parsed = parsePlannerJson(JSON.parse(extractJsonObject(raw)));
	const allowed = new Set(request.tools.map((tool) => tool.name));
	const maxSteps = Math.max(1, Math.min(MAX_PLAN_STEPS, request.maxSteps));
	const steps = parsed.steps.slice(0, maxSteps).map((step) => {
		if (!allowed.has(step.tool)) throw new Error(`planned tool is not available: ${step.tool}`);
		return {
			tool: step.tool,
			input: step.input.trim(),
			label: sanitizeStepLabel(step.label) || defaultStepLabel(step.tool, step.input),
			...(typeof step.laneId === 'string' && step.laneId.trim() ? { laneId: step.laneId.trim().slice(0, 80) } : {}),
			...(typeof step.lanePurpose === 'string' && step.lanePurpose.trim()
				? { lanePurpose: step.lanePurpose.trim().slice(0, 180) }
				: {})
		};
	});
	if (!steps.length) throw new Error('planner returned no usable steps');
	return { steps, reason: (parsed.reason || '').trim(), source: 'model' };
}

/** Deterministic plan derived from the regex router's decision. */
export function planFromRoute(route: RouteDecision, prompt: string): ResearchPlan {
	return {
		steps: route.tools_to_use.map((tool) => ({
			tool,
			input: prompt,
			label: defaultStepLabel(tool, prompt)
		})),
		reason: route.reason,
		source: 'router'
	};
}

/** Ask the model for the next bounded observe-act action set. */
export async function chooseNextLoopActions(request: LoopDecisionRequest): Promise<LoopDecision> {
	const raw = await completeProviderText({
		provider: request.provider,
		apiKey: request.apiKey,
		model: request.model,
		input: loopDecisionInput(request),
		instructions: [
			NEWSROOM_CHARTER,
			'You are the bounded newsroom loop controller.',
			'Choose only read-only research actions or the final synthesis action.',
			'Never choose shell, browser-control, filesystem, messaging, scheduling, deployment, memory-writing, or credential actions.',
			'Reply with JSON only; do not write an answer or claim facts.'
		].join('\n'),
		reasoningEffort: request.reasoningEffort || 'low',
		maxOutputTokens: 500,
		disableSearch: true,
		signal: request.signal
	});
	return parseLoopDecision(raw, request);
}

export function parseLoopDecision(
	raw: string,
	request: Pick<LoopDecisionRequest, 'tools' | 'skills' | 'maxActions'>
): LoopDecision {
	const value = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
	const allowedTools = new Set(request.tools.map((tool) => tool.name));
	const allowedSkills = new Set(request.skills.map((skill) => skill.id));
	const rawActions = Array.isArray(value.actions)
		? value.actions
		: typeof value.action === 'string'
			? [{ kind: value.action, tool: value.tool, input: value.input, label: value.label, skill: value.skill }]
			: [];
	if (!rawActions.length) throw new Error('loop decision returned no action');
	const maxActions = Math.max(1, Math.min(MAX_LOOP_ACTIONS, request.maxActions));
	const actions: LoopAction[] = [];
	const seen = new Set<string>();
	for (const rawAction of rawActions.slice(0, maxActions)) {
		if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
			throw new Error('loop action must be an object');
		}
		const action = rawAction as Record<string, unknown>;
		const kind = typeof action.kind === 'string' ? action.kind : typeof action.action === 'string' ? action.action : '';
		if (kind === 'synthesize' || kind === 'stop' || kind === 'finish') {
			actions.push({ kind: 'synthesize', reason: boundedOptional(action.reason, 220) });
			break;
		}
		if (kind !== 'research') throw new Error(`unsupported loop action: ${kind || 'missing kind'}`);
		const tool = boundedString(action.tool, 'loop action tool', 1, 120);
		if (!allowedTools.has(tool)) throw new Error(`loop action tool is not available: ${tool}`);
		const input = boundedString(action.input || '', 'loop action input', 1, 700);
		const key = `${tool}\n${input}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const skill = typeof action.skill === 'string' && allowedSkills.has(action.skill as NewsroomSkillId)
			? (action.skill as NewsroomSkillId)
			: undefined;
		actions.push({
			kind: 'research',
			tool,
			input,
			label: sanitizeStepLabel(typeof action.label === 'string' ? action.label : '') || defaultStepLabel(tool, input),
			...(skill ? { skill } : {}),
			...(action.parallel === true ? { parallel: true } : {}),
			...(typeof action.laneId === 'string' && action.laneId.trim() ? { laneId: action.laneId.trim().slice(0, 80) } : {}),
			...(typeof action.lanePurpose === 'string' && action.lanePurpose.trim()
				? { lanePurpose: action.lanePurpose.trim().slice(0, 180) }
				: {})
		});
	}
	if (!actions.length) throw new Error('loop decision contained no usable action');
	return {
		actions,
		reason: boundedOptional(value.reason, 300) || 'Continue only when another bounded research action can improve the verified answer.',
		source: 'model'
	};
}

/** Deterministic offline/failure fallback: consume the next safe route step. */
export function deterministicNextLoopDecision(input: {
	fallbackSteps: PlannedStep[];
	attempted: ReadonlySet<string>;
	maxActions?: number;
	preferSynthesis?: boolean;
}): LoopDecision {
	if (input.preferSynthesis) {
		return { actions: [{ kind: 'synthesize', reason: 'The deterministic evaluator found no higher-value safe research step.' }], reason: 'Synthesize the verified subset.', source: 'router' };
	}
	const candidates = input.fallbackSteps.filter((step) => !input.attempted.has(`${step.tool}\n${step.input}`));
	const maxActions = Math.max(1, Math.min(MAX_LOOP_ACTIONS, input.maxActions || 1));
	const actions = candidates.slice(0, maxActions).map((step) => ({
		kind: 'research' as const,
		tool: step.tool,
		input: step.input,
		label: step.label,
		...(maxActions > 1 ? { parallel: true } : {})
	}));
	return actions.length
		? { actions, reason: 'Use the next deterministic route step as an offline-safe fallback.', source: 'router' }
		: { actions: [{ kind: 'synthesize', reason: 'No untried safe research step remains.' }], reason: 'Synthesize the verified subset.', source: 'router' };
}

export function defaultStepLabel(tool: string, input = ''): string {
	if (tool === NEWSROOM_TOOL_NAMES.webSearch) return 'Searching recent coverage';
	if (tool === NEWSROOM_TOOL_NAMES.sourceMonitor) return 'Checking configured sources';
	if (tool === NEWSROOM_TOOL_NAMES.sourceFeedFetcher) return 'Reading source feeds';
	if (tool === NEWSROOM_TOOL_NAMES.researchResultReader) return 'Reading saved research';
	if (tool === NEWSROOM_TOOL_NAMES.urlFetchRead) return readingLabelForUrl(input);
	if (tool === NEWSROOM_TOOL_NAMES.pdfTextExtractor) return 'Extracting document text';
	if (tool === NEWSROOM_TOOL_NAMES.browserAutomation) return 'Inspecting the page';
	if (tool === NEWSROOM_TOOL_NAMES.briefGenerator) return 'Drafting the brief';
	return 'Researching';
}

export function readingLabelForUrl(value: string): string {
	const url = value.match(/https?:\/\/[^\s)>\]]+/i)?.[0];
	if (!url) return 'Reading the source page';
	try {
		return `Reading ${new URL(url).hostname.replace(/^www\./, '')}`;
	} catch {
		return 'Reading the source page';
	}
}

function plannerInput(request: PlannerRequest): string {
	const tools = request.tools
		.map((tool) => `- ${tool.name}: ${tool.when_to_use}`)
		.join('\n');
	const monitors = request.sourceMonitors.length
		? request.sourceMonitors.map((monitor) => `- ${monitor.name} (${monitor.tags.join(', ')})`).join('\n')
		: '- none configured';
	const maxSteps = Math.max(1, Math.min(MAX_PLAN_STEPS, request.maxSteps));
	return [
		NEWSROOM_CHARTER,
		'',
		formatNewsroomTemporalContext(request.temporalContext),
		'',
		'You plan research steps for a newsroom assistant. Reply with JSON only, no prose, in this exact shape:',
		'{"reason":"one short sentence","steps":[{"tool":"tool_name","input":"concrete query, URL, or instruction","label":"short human progress label"}]}',
		'Rules:',
		`- 1 to ${maxSteps} steps; most requests need 1 or 2. Each step runs one tool once.`,
		'- input is what the tool acts on: a focused search query (not the raw request), a URL to read, or feed URLs.',
		'- label is shown to the user while the step runs (e.g. "Checking Toronto police releases"). Never mention tool, adapter, or model names in labels.',
		'- For current events, prefer configured/official sources before broad web search when a configured monitor clearly matches.',
		...(request.researchContract
			? [
					`- The structured request contract below is authoritative. Preserve its subject, location, time window, count, direct-page requirement, and every exclusion in every step; never add a category the contract excludes.`,
					`- Structured request contract: ${formatResearchRequestContract(request.researchContract)}`
				]
			: []),
		'- For latest/current requests, search the requested time window and put the newest supported developments first. Older background is not a latest update.',
		'- For a broad latest/news roundup, plan bounded discovery, official/public-impact, and corroboration passes when the budget permits; each pass should gather findings for one final synthesis, never a separate answer.',
		`- Make the local date explicit in current-news queries (${request.temporalContext.localDate}) and require specific readable article or official pages rather than publisher hubs or result pages.`,
		'- Never invent URLs. Only read URLs that appear in the request.',
		'- For multi-part questions, you may plan one focused web search per distinct part.',
		'Available tools:',
		tools,
		'Configured source monitors:',
		monitors,
		`Router hint (fallback heuristic, you may override): mode=${request.route.selected_mode}; tools=${request.route.tools_to_use.join(', ') || 'none'}.`,
		'Request:',
		request.prompt
	].join('\n');
}

function loopDecisionInput(request: LoopDecisionRequest): string {
	const tools = request.tools.map((tool) => `- ${tool.name}: ${tool.when_to_use}`).join('\n') || '- none';
	const skills = request.skills.map((skill) => `- ${skill.id}: ${skill.summary}`).join('\n') || '- none';
	const gaps = request.evaluation.gaps.length ? request.evaluation.gaps.map((gap) => `- ${gap}`).join('\n') : '- none recorded';
	return [
		request.promptLayers.stable,
		request.promptLayers.context,
		request.promptLayers.volatile,
		'Loop decision contract:',
		`- Iteration ${request.iteration} of ${request.maxIterations}; at most ${Math.max(1, Math.min(MAX_LOOP_ACTIONS, request.maxActions))} actions.`,
		`- Already attempted action keys: ${[...request.attempted].slice(-12).join(' | ') || 'none'}`,
		`- Current contract completeness: ${request.evaluation.completeness.toFixed(2)}.`,
		`- Can synthesize now: ${request.evaluation.can_synthesize ? 'yes' : 'no'}.`,
		'Remaining gaps:',
		gaps,
		'Allowed progressive-disclosure skills:',
		skills,
		'Allowed read-only tools:',
		tools,
		'Return exactly this shape: {"reason":"short rationale","actions":[{"kind":"research","tool":"registered_tool","input":"focused query or URL","label":"short progress label","skill":"skill_id","parallel":true}]} or {"reason":"...","actions":[{"kind":"synthesize"}]}.',
		`Current request: ${request.request}`
	].join('\n\n');
}

function sanitizeStepLabel(value: string): string {
	return value
		.replace(/https?:\/\/\S+/gi, '')
		.replace(/[*_`#[\]]+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
}

function extractJsonObject(raw: string): string {
	const text = raw.replace(/```(?:json)?/gi, '').trim();
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) throw new Error('planner reply contained no JSON object');
	return text.slice(start, end + 1);
}

function parsePlannerJson(value: unknown): { reason?: string; steps: PlannedStep[] } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('planner reply must be a JSON object');
	}
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.steps) || record.steps.length < 1) {
		throw new Error('planner reply must include at least one step');
	}
	const steps = record.steps.slice(0, MAX_PLAN_STEPS).map((step) => {
		if (!step || typeof step !== 'object' || Array.isArray(step)) {
			throw new Error('planner step must be an object');
		}
		const item = step as Record<string, unknown>;
		const tool = boundedString(item.tool, 'planner step tool', 1, 120);
		const input = boundedString(item.input, 'planner step input', 1, 600);
		const label = boundedString(item.label, 'planner step label', 1, 120);
		const laneId = typeof item.laneId === 'string' ? item.laneId : undefined;
		const lanePurpose = typeof item.lanePurpose === 'string' ? item.lanePurpose : undefined;
		return { tool, input, label, ...(laneId ? { laneId } : {}), ...(lanePurpose ? { lanePurpose } : {}) };
	});
	return {
		reason: typeof record.reason === 'string' ? record.reason : undefined,
		steps
	};
}

function boundedString(value: unknown, label: string, min: number, max: number): string {
	if (typeof value !== 'string') throw new Error(`${label} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length < min) throw new Error(`${label} is required`);
	if (trimmed.length > max) throw new Error(`${label} is too long`);
	return trimmed;
}

function boundedOptional(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : undefined;
}
