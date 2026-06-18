import { DEFAULT_TOOL_BUDGET, mergeToolBudget, type ToolBudget } from './budget.js';
import {
	createModelPolicyConfig,
	loadModelPolicyConfigFromEnv,
	type ModelPolicyConfig,
	type ModelPolicyOverrides
} from './model-policy.js';
import { NEWSROOM_TOOL_NAMES } from './router.js';
import type { ModelProvider } from '../util/openai-complete.js';

interface SourceMonitorConfig {
	name: string;
	url: string;
	kind: 'official' | 'media_report' | 'primary' | 'internal';
	priority: number;
	tags: string[];
}

export interface NewsroomAgentConfig {
	enabled_tools: string[];
	model_provider: ModelProvider;
	/** Model-driven step planning; the regex router remains the fallback. */
	planner_enabled: boolean;
	default_tool_budget: ToolBudget;
	source_priority: Array<'official' | 'primary' | 'source_monitor' | 'internal' | 'media_report' | 'unknown'>;
	routing_rules: Record<string, string>;
	stop_conditions: string[];
	required_citation_behavior: {
		citations_required_for_research: boolean;
		list_sources: boolean;
		preserve_timestamps: boolean;
		flag_conflicts: boolean;
		distinguish_official_sources: boolean;
		answer_with_limitations_when_incomplete: boolean;
	};
	source_monitors: SourceMonitorConfig[];
	web_search_model: string;
	model_policy: ModelPolicyConfig;
}

const DEFAULT_SOURCE_MONITORS: SourceMonitorConfig[] = [
	{
		name: 'Toronto Police Service news releases',
		url: 'https://www.tps.ca/media-centre/news-releases/',
		kind: 'official',
		priority: 10,
		tags: ['toronto', 'police', 'public safety', 'releases']
	},
	{
		name: 'City of Toronto news releases',
		url: 'https://www.toronto.ca/news/',
		kind: 'official',
		priority: 8,
		tags: ['toronto', 'city', 'municipal', 'releases']
	}
];

export function createNewsroomAgentConfig(overrides: Partial<NewsroomAgentConfig> = {}): NewsroomAgentConfig {
	const defaultBudget = mergeToolBudget(overrides.default_tool_budget || DEFAULT_TOOL_BUDGET);
	return {
		enabled_tools:
			overrides.enabled_tools || [
				NEWSROOM_TOOL_NAMES.sourceMonitor,
				NEWSROOM_TOOL_NAMES.sourceFeedFetcher,
				NEWSROOM_TOOL_NAMES.researchResultReader,
				NEWSROOM_TOOL_NAMES.webSearch,
				NEWSROOM_TOOL_NAMES.urlFetchRead,
				NEWSROOM_TOOL_NAMES.browserAutomation,
				NEWSROOM_TOOL_NAMES.pdfTextExtractor,
				NEWSROOM_TOOL_NAMES.briefGenerator
			],
		planner_enabled: overrides.planner_enabled ?? true,
		default_tool_budget: defaultBudget,
		source_priority: overrides.source_priority || [
			'official',
			'primary',
			'source_monitor',
			'internal',
			'media_report',
			'unknown'
		],
		routing_rules: {
			answer_from_memory: 'Use only for stable newsroom guidance or requests that do not need current facts.',
			custom_tool: 'Prefer registered internal tools for saved research, supplied URLs, PDFs, briefs, or newsroom-specific tasks.',
			source_monitor: 'Use configured source monitors and feeds for latest releases or known source checks.',
			web_search: 'Use provider-backed web search for broad discovery, other outlets, or related coverage.',
			browser_automation: 'Use only for direct page interaction, dynamic pages, niche inspection, or tasks that need clicking.',
			hybrid_research: 'Combine primary/internal tools with web_search when both source evidence and broader context are needed.',
			clarification_needed: 'Stop and ask for the missing source, story, or task target.'
		},
		stop_conditions: [
			'enough evidence exists to answer',
			'the configured tool budget is exhausted',
			'the source is blocked or unavailable',
			'the task requires login, CAPTCHA, or paywall access',
			'more research is unlikely to materially improve the answer'
		],
		required_citation_behavior: {
			citations_required_for_research: true,
			list_sources: true,
			preserve_timestamps: true,
			flag_conflicts: true,
			distinguish_official_sources: true,
			answer_with_limitations_when_incomplete: true,
			...overrides.required_citation_behavior
		},
		source_monitors: overrides.source_monitors || DEFAULT_SOURCE_MONITORS,
		model_policy: createModelPolicyConfig(overrides.model_policy as ModelPolicyOverrides | undefined),
		model_provider: overrides.model_provider || 'perplexity',
		web_search_model: overrides.web_search_model || 'perplexity/sonar'
	};
}

export function loadNewsroomAgentConfigFromEnv(overrides: Partial<NewsroomAgentConfig> = {}): NewsroomAgentConfig {
	const envBudget = mergeToolBudget({
		max_total_tool_calls: intFromEnv(process.env.NEWSROOM_HARNESS_MAX_TOOL_CALLS),
		max_custom_tool_calls: intFromEnv(process.env.NEWSROOM_HARNESS_MAX_CUSTOM_TOOL_CALLS),
		max_web_searches: intFromEnv(process.env.NEWSROOM_HARNESS_MAX_WEB_SEARCHES),
		max_browser_tasks: intFromEnv(process.env.NEWSROOM_HARNESS_MAX_BROWSER_TASKS),
		max_runtime_seconds: intFromEnv(process.env.NEWSROOM_HARNESS_RUN_TIMEOUT_SECONDS)
	});
	const monitors = parseSourceMonitors(process.env.NEWSROOM_AGENT_SOURCE_MONITORS_JSON);
	return createNewsroomAgentConfig({
		...overrides,
		default_tool_budget: envBudget,
		enabled_tools: csv(process.env.NEWSROOM_AGENT_ENABLED_TOOLS) || overrides.enabled_tools,
		model_provider: modelProviderFromEnv(process.env.NEWSROOM_MODEL_PROVIDER) || overrides.model_provider,
		planner_enabled: boolEnv(process.env.NEWSROOM_AGENT_PLANNER_ENABLED) ?? overrides.planner_enabled,
		source_priority: csv(process.env.NEWSROOM_AGENT_SOURCE_PRIORITY) as NewsroomAgentConfig['source_priority'],
		source_monitors: monitors || overrides.source_monitors,
		model_policy: loadModelPolicyConfigFromEnv(overrides.model_policy as ModelPolicyOverrides | undefined),
		web_search_model:
			process.env.NEWSROOM_WEB_SEARCH_MODEL ||
			(overrides.model_policy as ModelPolicyOverrides | undefined)?.models?.web_search ||
			overrides.web_search_model
	});
}

function modelProviderFromEnv(value: string | undefined): ModelProvider | undefined {
	if (value === 'openai' || value === 'perplexity') return value;
	return undefined;
}

function boolEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
	if (/^(0|false|no|off)$/i.test(value.trim())) return false;
	return undefined;
}

function intFromEnv(value: string | undefined): number | undefined {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

function csv(value: string | undefined): string[] | undefined {
	const parsed = value
		?.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
	return parsed?.length ? parsed : undefined;
}

function parseSourceMonitors(value: string | undefined): SourceMonitorConfig[] | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return undefined;
		return parsed
			.map((item) => ({
				name: String(item.name || '').trim(),
				url: String(item.url || '').trim(),
				kind: ['official', 'media_report', 'primary', 'internal'].includes(item.kind) ? item.kind : 'primary',
				priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 5,
				tags: Array.isArray(item.tags) ? item.tags.map(String) : []
			}))
			.filter((item) => item.name && item.url);
	} catch {
		return undefined;
	}
}
