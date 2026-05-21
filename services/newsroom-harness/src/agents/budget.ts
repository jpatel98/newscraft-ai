export interface ToolBudget {
	max_total_tool_calls: number;
	max_custom_tool_calls: number;
	max_web_searches: number;
	max_browser_tasks: number;
	max_runtime_seconds: number;
}

interface ToolBudgetUsage {
	total_tool_calls: number;
	custom_tool_calls: number;
	web_searches: number;
	browser_tasks: number;
	elapsed_seconds: number;
}

export interface ToolBudgetSnapshot {
	limits: ToolBudget;
	usage: ToolBudgetUsage;
	remaining: ToolBudgetUsage;
	exhausted: boolean;
}

export type BudgetedToolKind = 'custom' | 'web_search' | 'browser_automation';

export const DEFAULT_TOOL_BUDGET: ToolBudget = {
	max_total_tool_calls: 6,
	max_custom_tool_calls: 4,
	max_web_searches: 3,
	max_browser_tasks: 2,
	max_runtime_seconds: 90
};

export function mergeToolBudget(overrides: Partial<ToolBudget> = {}): ToolBudget {
	return {
		max_total_tool_calls: positiveInteger(overrides.max_total_tool_calls, DEFAULT_TOOL_BUDGET.max_total_tool_calls),
		max_custom_tool_calls: positiveInteger(overrides.max_custom_tool_calls, DEFAULT_TOOL_BUDGET.max_custom_tool_calls),
		max_web_searches: positiveInteger(overrides.max_web_searches, DEFAULT_TOOL_BUDGET.max_web_searches),
		max_browser_tasks: positiveInteger(overrides.max_browser_tasks, DEFAULT_TOOL_BUDGET.max_browser_tasks),
		max_runtime_seconds: positiveInteger(overrides.max_runtime_seconds, DEFAULT_TOOL_BUDGET.max_runtime_seconds)
	};
}

export function budgetKindForToolCategory(category: string): BudgetedToolKind {
	if (category === 'web_search_provider') return 'web_search';
	if (category === 'browser_automation_provider') return 'browser_automation';
	return 'custom';
}

export class ToolBudgetLedger {
	private readonly startedAt = Date.now();
	private totalToolCalls = 0;
	private customToolCalls = 0;
	private webSearches = 0;
	private browserTasks = 0;

	constructor(readonly limits: ToolBudget) {}

	canUse(kind: BudgetedToolKind, now = Date.now()): { ok: true } | { ok: false; reason: string } {
		if (this.elapsedSeconds(now) >= this.limits.max_runtime_seconds) {
			return { ok: false, reason: 'max_runtime_seconds exhausted' };
		}
		if (this.totalToolCalls >= this.limits.max_total_tool_calls) {
			return { ok: false, reason: 'max_total_tool_calls exhausted' };
		}
		if (kind === 'custom' && this.customToolCalls >= this.limits.max_custom_tool_calls) {
			return { ok: false, reason: 'max_custom_tool_calls exhausted' };
		}
		if (kind === 'web_search' && this.webSearches >= this.limits.max_web_searches) {
			return { ok: false, reason: 'max_web_searches exhausted' };
		}
		if (kind === 'browser_automation' && this.browserTasks >= this.limits.max_browser_tasks) {
			return { ok: false, reason: 'max_browser_tasks exhausted' };
		}
		return { ok: true };
	}

	consume(kind: BudgetedToolKind, now = Date.now()): void {
		const allowed = this.canUse(kind, now);
		if (!allowed.ok) throw new Error(allowed.reason);
		this.totalToolCalls += 1;
		if (kind === 'custom') this.customToolCalls += 1;
		if (kind === 'web_search') this.webSearches += 1;
		if (kind === 'browser_automation') this.browserTasks += 1;
	}

	isRuntimeExhausted(now = Date.now()): boolean {
		return this.elapsedSeconds(now) >= this.limits.max_runtime_seconds;
	}

	snapshot(now = Date.now()): ToolBudgetSnapshot {
		const usage: ToolBudgetUsage = {
			total_tool_calls: this.totalToolCalls,
			custom_tool_calls: this.customToolCalls,
			web_searches: this.webSearches,
			browser_tasks: this.browserTasks,
			elapsed_seconds: this.elapsedSeconds(now)
		};
		const remaining: ToolBudgetUsage = {
			total_tool_calls: Math.max(0, this.limits.max_total_tool_calls - usage.total_tool_calls),
			custom_tool_calls: Math.max(0, this.limits.max_custom_tool_calls - usage.custom_tool_calls),
			web_searches: Math.max(0, this.limits.max_web_searches - usage.web_searches),
			browser_tasks: Math.max(0, this.limits.max_browser_tasks - usage.browser_tasks),
			elapsed_seconds: Math.max(0, this.limits.max_runtime_seconds - usage.elapsed_seconds)
		};
		return {
			limits: this.limits,
			usage,
			remaining,
			exhausted:
				remaining.total_tool_calls === 0 ||
				remaining.elapsed_seconds === 0 ||
				(kindLimitExhausted('custom', usage, this.limits) &&
					kindLimitExhausted('web_search', usage, this.limits) &&
					kindLimitExhausted('browser_automation', usage, this.limits))
		};
	}

	private elapsedSeconds(now: number): number {
		return Math.max(0, Math.ceil((now - this.startedAt) / 1000));
	}
}

function kindLimitExhausted(kind: BudgetedToolKind, usage: ToolBudgetUsage, limits: ToolBudget): boolean {
	if (kind === 'custom') return usage.custom_tool_calls >= limits.max_custom_tool_calls;
	if (kind === 'web_search') return usage.web_searches >= limits.max_web_searches;
	return usage.browser_tasks >= limits.max_browser_tasks;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && Number(value) > 0 ? Math.round(Number(value)) : fallback;
}
