export type ModelTier = 'none' | 'nano' | 'mini' | 'standard' | 'premium';

export type ModelPolicyMode = 'cost_saver' | 'balanced' | 'quality';

export type ModelPolicyTask =
	| 'title'
	| 'interactive_chat'
	| 'scheduled_research_update'
	| 'manual_research_update'
	| 'web_search';

export interface ModelPolicyTaskConfig {
	tier: ModelTier;
	reasoning_effort?: 'low' | 'medium' | 'high';
}

export interface ModelPolicyConfig {
	mode: ModelPolicyMode;
	models: {
		nano: string;
		mini: string;
		standard: string;
		premium: string;
		web_search: string;
	};
	tasks: Record<ModelPolicyTask, ModelPolicyTaskConfig>;
	scheduled: {
		allow_model_calls: boolean;
		allow_web_search: boolean;
	};
	require_premium_confirmation: boolean;
	allow_request_model_override: boolean;
}

export type ModelPolicyOverrides = Omit<Partial<ModelPolicyConfig>, 'models' | 'tasks' | 'scheduled'> & {
	models?: Partial<ModelPolicyConfig['models']>;
	tasks?: Partial<Record<ModelPolicyTask, ModelPolicyTaskConfig>>;
	scheduled?: Partial<ModelPolicyConfig['scheduled']>;
};

export interface ModelPolicyDecision {
	allowed: boolean;
	task: ModelPolicyTask;
	tier: ModelTier;
	model: string | null;
	reasoningEffort?: 'low' | 'medium' | 'high';
	reason: string;
	trigger: 'manual' | 'schedule' | 'test';
}

export interface ResolveModelPolicyOptions {
	trigger?: 'manual' | 'schedule' | 'test';
	requestedModel?: string;
	premiumApproved?: boolean;
}

const DEFAULT_MODELS = {
	nano: 'openai/gpt-5-mini',
	mini: 'openai/gpt-5-mini',
	standard: 'openai/gpt-5-mini',
	premium: 'openai/gpt-5.5',
	web_search: 'openai/gpt-5-mini'
};

export function createModelPolicyConfig(overrides: ModelPolicyOverrides = {}): ModelPolicyConfig {
	const mode = overrides.mode || 'cost_saver';
	return {
		mode,
		models: {
			...DEFAULT_MODELS,
			...definedValues(overrides.models)
		},
		tasks: {
			...defaultTasksForMode(mode),
			...overrides.tasks
		},
		scheduled: {
			allow_model_calls: false,
			allow_web_search: false,
			...overrides.scheduled
		},
		require_premium_confirmation: overrides.require_premium_confirmation ?? true,
		allow_request_model_override: overrides.allow_request_model_override ?? false
	};
}

export function loadModelPolicyConfigFromEnv(overrides: ModelPolicyOverrides = {}): ModelPolicyConfig {
	const mode = modeFromEnv(process.env.NEWSROOM_MODEL_POLICY_MODE) || overrides.mode;
	const policy = createModelPolicyConfig({
		...overrides,
		mode,
		models: {
			...overrides.models,
			nano: process.env.NEWSROOM_MODEL_NANO || overrides.models?.nano,
			mini: process.env.NEWSROOM_MODEL_MINI || overrides.models?.mini,
			standard: process.env.NEWSROOM_MODEL_STANDARD || overrides.models?.standard,
			premium: process.env.NEWSROOM_MODEL_PREMIUM || overrides.models?.premium,
			web_search: process.env.NEWSROOM_WEB_SEARCH_MODEL || overrides.models?.web_search
		},
		scheduled: {
			...overrides.scheduled,
			allow_model_calls: boolFromEnv(
				process.env.NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS,
				overrides.scheduled?.allow_model_calls
			),
			allow_web_search: boolFromEnv(
				process.env.NEWSROOM_ALLOW_SCHEDULED_WEB_SEARCH,
				overrides.scheduled?.allow_web_search
			)
		},
		allow_request_model_override: boolFromEnv(
			process.env.NEWSROOM_ALLOW_REQUEST_MODEL_OVERRIDE,
			overrides.allow_request_model_override
		),
		require_premium_confirmation: boolFromEnv(
			process.env.NEWSROOM_REQUIRE_PREMIUM_CONFIRMATION,
			overrides.require_premium_confirmation
		)
	});

	return withTaskEnvOverrides(policy);
}

export function resolveModelPolicy(
	policy: ModelPolicyConfig,
	task: ModelPolicyTask,
	options: ResolveModelPolicyOptions = {}
): ModelPolicyDecision {
	const trigger = options.trigger || 'manual';
	const taskPolicy = policy.tasks[task];
	const tier = taskPolicy.tier;

	if (trigger === 'schedule' && task === 'web_search' && !policy.scheduled.allow_web_search) {
		return denied(task, tier, trigger, 'Scheduled web search is disabled by model policy.');
	}
	if (trigger === 'schedule' && task !== 'web_search' && !policy.scheduled.allow_model_calls) {
		return denied(task, tier, trigger, 'Scheduled model calls are disabled by model policy.');
	}
	if (tier === 'none') {
		return denied(task, tier, trigger, 'This task is configured to run without a model.');
	}
	if (tier === 'premium' && policy.require_premium_confirmation && !options.premiumApproved) {
		return denied(task, tier, trigger, 'Premium model tier requires explicit confirmation.');
	}

	const requested = policy.allow_request_model_override ? concreteModel(options.requestedModel) : null;
	const model = requested || modelForTier(policy, task, tier);
	return {
		allowed: Boolean(model),
		task,
		tier,
		model: model || null,
		reasoningEffort: taskPolicy.reasoning_effort,
		reason: model ? `Using ${tier} model tier for ${task}.` : `No model configured for ${tier} tier.`,
		trigger
	};
}

function defaultTasksForMode(mode: ModelPolicyMode): Record<ModelPolicyTask, ModelPolicyTaskConfig> {
	if (mode === 'quality') {
		return {
			title: { tier: 'nano', reasoning_effort: 'low' },
			interactive_chat: { tier: 'standard', reasoning_effort: 'medium' },
			scheduled_research_update: { tier: 'mini', reasoning_effort: 'low' },
			manual_research_update: { tier: 'standard', reasoning_effort: 'medium' },
			web_search: { tier: 'standard', reasoning_effort: 'low' }
		};
	}
	if (mode === 'balanced') {
		return {
			title: { tier: 'nano', reasoning_effort: 'low' },
			interactive_chat: { tier: 'mini', reasoning_effort: 'low' },
			scheduled_research_update: { tier: 'mini', reasoning_effort: 'low' },
			manual_research_update: { tier: 'mini', reasoning_effort: 'low' },
			web_search: { tier: 'standard', reasoning_effort: 'low' }
		};
	}
	return {
		title: { tier: 'nano', reasoning_effort: 'low' },
		interactive_chat: { tier: 'mini', reasoning_effort: 'low' },
		scheduled_research_update: { tier: 'none' },
		manual_research_update: { tier: 'mini', reasoning_effort: 'low' },
		web_search: { tier: 'standard', reasoning_effort: 'low' }
	};
}

function withTaskEnvOverrides(policy: ModelPolicyConfig): ModelPolicyConfig {
	return {
		...policy,
		tasks: {
			title: taskWithTier(policy.tasks.title, process.env.NEWSROOM_MODEL_TIER_TITLE),
			interactive_chat: taskWithTier(policy.tasks.interactive_chat, process.env.NEWSROOM_MODEL_TIER_CHAT),
			scheduled_research_update: taskWithTier(
				policy.tasks.scheduled_research_update,
				process.env.NEWSROOM_MODEL_TIER_SCHEDULED_RESEARCH_UPDATE
			),
			manual_research_update: taskWithTier(
				policy.tasks.manual_research_update,
				process.env.NEWSROOM_MODEL_TIER_MANUAL_RESEARCH_UPDATE
			),
			web_search: taskWithTier(policy.tasks.web_search, process.env.NEWSROOM_MODEL_TIER_WEB_SEARCH)
		}
	};
}

function taskWithTier(task: ModelPolicyTaskConfig, value: string | undefined): ModelPolicyTaskConfig {
	const tier = tierFromEnv(value);
	return tier ? { ...task, tier } : task;
}

function modelForTier(policy: ModelPolicyConfig, task: ModelPolicyTask, tier: Exclude<ModelTier, 'none'>): string {
	if (task === 'web_search') return policy.models.web_search;
	return policy.models[tier];
}

function denied(
	task: ModelPolicyTask,
	tier: ModelTier,
	trigger: 'manual' | 'schedule' | 'test',
	reason: string
): ModelPolicyDecision {
	return {
		allowed: false,
		task,
		tier,
		model: null,
		reason,
		trigger
	};
}

function concreteModel(value: string | undefined): string | null {
	const model = value?.trim();
	if (!model) return null;
	if (['newsroom-agent', 'newsroom-harness', 'hermes-agent'].includes(model)) return null;
	return model;
}

function modeFromEnv(value: string | undefined): ModelPolicyMode | undefined {
	if (value === 'cost_saver' || value === 'balanced' || value === 'quality') return value;
	return undefined;
}

function tierFromEnv(value: string | undefined): ModelTier | undefined {
	if (value === 'none' || value === 'nano' || value === 'mini' || value === 'standard' || value === 'premium') return value;
	return undefined;
}

function boolFromEnv(value: string | undefined, fallback = false): boolean {
	if (value === undefined) return fallback;
	if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
	if (/^(0|false|no|off)$/i.test(value.trim())) return false;
	return fallback;
}

function definedValues<T extends Record<string, unknown>>(value: T | undefined): Partial<T> {
	if (!value) return {};
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
