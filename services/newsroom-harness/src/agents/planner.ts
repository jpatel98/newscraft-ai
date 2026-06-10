import { z } from 'zod';
import type { RouteDecision } from './router.js';
import { NEWSROOM_TOOL_NAMES } from './router.js';
import { completeOpenAiText } from '../util/openai-complete.js';

/**
 * The planner turns a newsroom request into an explicit, bounded list of tool
 * steps. The regex router stays as the offline/no-model fallback and its
 * decision remains the spine for budgets, output mode, and answer generation;
 * the planner refines *which* tools run, with concrete per-step inputs and
 * human-facing progress labels.
 */

export interface PlannedStep {
	tool: string;
	input: string;
	label: string;
}

export interface ResearchPlan {
	steps: PlannedStep[];
	reason: string;
	source: 'model' | 'router';
}

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
	model: string;
	reasoningEffort?: 'low' | 'medium' | 'high';
	signal?: AbortSignal;
}

export type PlannerFn = (request: PlannerRequest) => Promise<ResearchPlan>;

const MAX_PLAN_STEPS = 4;
const plannedStepSchema = z.object({
	tool: z.string().min(1),
	input: z.string().min(1).max(600),
	label: z.string().min(1).max(120)
});
const planSchema = z.object({
	reason: z.string().optional(),
	steps: z.array(plannedStepSchema).min(1).max(MAX_PLAN_STEPS)
});

export async function planResearchSteps(request: PlannerRequest): Promise<ResearchPlan> {
	const raw = await completeOpenAiText({
		apiKey: request.apiKey,
		model: request.model,
		input: plannerInput(request),
		reasoningEffort: request.reasoningEffort || 'low',
		maxOutputTokens: 600,
		signal: request.signal
	});
	return parseResearchPlan(raw, request);
}

export function parseResearchPlan(raw: string, request: Pick<PlannerRequest, 'tools' | 'maxSteps'>): ResearchPlan {
	const parsed = planSchema.parse(JSON.parse(extractJsonObject(raw)));
	const allowed = new Set(request.tools.map((tool) => tool.name));
	const maxSteps = Math.max(1, Math.min(MAX_PLAN_STEPS, request.maxSteps));
	const steps = parsed.steps.slice(0, maxSteps).map((step) => {
		if (!allowed.has(step.tool)) throw new Error(`planned tool is not available: ${step.tool}`);
		return {
			tool: step.tool,
			input: step.input.trim(),
			label: sanitizeStepLabel(step.label) || defaultStepLabel(step.tool, step.input)
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
		'You plan research steps for a newsroom assistant. Reply with JSON only, no prose, in this exact shape:',
		'{"reason":"one short sentence","steps":[{"tool":"tool_name","input":"concrete query, URL, or instruction","label":"short human progress label"}]}',
		'Rules:',
		`- 1 to ${maxSteps} steps; most requests need 1 or 2. Each step runs one tool once.`,
		'- input is what the tool acts on: a focused search query (not the raw request), a URL to read, or feed URLs.',
		'- label is shown to the user while the step runs (e.g. "Checking Toronto police releases"). Never mention tool, adapter, or model names in labels.',
		'- For current events, prefer configured/official sources before broad web search when a configured monitor clearly matches.',
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
