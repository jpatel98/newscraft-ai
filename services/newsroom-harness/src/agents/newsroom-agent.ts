import type { HarnessRepository } from '../db/repository.js';
import { generateFinalAnswer } from './answer.js';
import {
	budgetKindForToolCategory,
	mergeToolBudget,
	ToolBudgetLedger,
	type ToolBudgetSnapshot
} from './budget.js';
import { createDefaultToolRegistry } from './default-tools.js';
import { dedupeEvidence, evidenceHasBlockingLimitation, isUsableEvidence, type EvidenceObject } from './evidence.js';
import {
	createNewsroomAgentConfig,
	type NewsroomAgentConfig
} from './harness-config.js';
import { NEWSROOM_TOOL_NAMES, routeNewsroomRequest, type RouteDecision } from './router.js';
import type { NewsroomTool, ToolRegistry, ToolRunContext, ToolRunOutput } from './tools.js';

export interface NewsroomAgentRunContext {
	repository?: HarnessRepository;
	runId?: string;
	jobId?: string;
	openAiApiKey?: string;
	trigger?: 'manual' | 'schedule' | 'test';
	signal?: AbortSignal;
	outputStyle?: 'report' | 'chat';
	onToolEvent?: (event: AgentToolEvent) => void;
}

interface AgentToolCallRecord {
	name: string;
	status: ToolRunOutput['status'] | 'skipped';
	limitations: string[];
	evidence_count: number;
}

export interface AgentToolEvent {
	type: 'tool_started' | 'tool_completed' | 'tool_skipped';
	tool: string;
	status?: string;
	detail?: string;
	evidence?: EvidenceObject[];
}

export interface NewsroomAgentRunResult {
	prompt: string;
	decision: RouteDecision;
	evidence: EvidenceObject[];
	final_answer: string;
	limitations: string[];
	tool_calls: AgentToolCallRecord[];
	budget: ToolBudgetSnapshot;
	stopped_reason: string;
}

export interface DisciplinedNewsroomAgentOptions {
	config?: Partial<NewsroomAgentConfig>;
	registry?: ToolRegistry;
	repository?: HarnessRepository;
	openAiApiKey?: string;
}

export class DisciplinedNewsroomAgent {
	private readonly config: NewsroomAgentConfig;
	private readonly registry: ToolRegistry;

	constructor(private readonly options: DisciplinedNewsroomAgentOptions = {}) {
		this.config = createNewsroomAgentConfig(options.config);
		this.registry = options.registry || createDefaultToolRegistry();
	}

	async run(prompt: string, context: NewsroomAgentRunContext = {}): Promise<NewsroomAgentRunResult> {
		const decision = routeNewsroomRequest(prompt, {
			default_tool_budget: this.config.default_tool_budget
		});
		const ledger = new ToolBudgetLedger(
			mergeToolBudget({
				...decision.tool_budget,
				...this.config.default_tool_budget
			})
		);
		const evidence: EvidenceObject[] = [];
		const limitations: string[] = [];
		const toolAnswers: string[] = [];
		const toolCalls: AgentToolCallRecord[] = [];
		let stoppedReason = decision.stop_condition;

		if (decision.selected_mode === 'answer_from_memory' || decision.selected_mode === 'clarification_needed') {
			const budget = ledger.snapshot();
			return {
				prompt,
				decision,
				evidence,
				final_answer: generateFinalAnswer({ prompt, decision, evidence, limitations, budget, outputStyle: context.outputStyle }),
				limitations,
				tool_calls: toolCalls,
				budget,
				stopped_reason: decision.selected_mode
			};
		}

		const signal = combinedSignal(context.signal, decision.tool_budget.max_runtime_seconds);

		for (const toolName of decision.tools_to_use) {
			if (signal.aborted || ledger.isRuntimeExhausted()) {
				stoppedReason = 'max_runtime_seconds exhausted';
				limitations.push(stoppedReason);
				break;
			}
			if (!this.config.enabled_tools.includes(toolName)) {
				const reason = `Tool disabled by harness config: ${toolName}`;
				limitations.push(reason);
				toolCalls.push({ name: toolName, status: 'skipped', limitations: [reason], evidence_count: 0 });
				context.onToolEvent?.({ type: 'tool_skipped', tool: toolName, detail: reason });
				continue;
			}
			const tool = this.registry.get(toolName);
			if (!tool) {
				const reason = `Tool is not registered: ${toolName}`;
				limitations.push(reason);
				toolCalls.push({ name: toolName, status: 'skipped', limitations: [reason], evidence_count: 0 });
				context.onToolEvent?.({ type: 'tool_skipped', tool: toolName, detail: reason });
				continue;
			}
			const budgetKind = budgetKindForToolCategory(tool.category);
			const allowed = ledger.canUse(budgetKind);
			if (!allowed.ok) {
				stoppedReason = allowed.reason;
				limitations.push(allowed.reason);
				break;
			}

			ledger.consume(budgetKind);
			context.onToolEvent?.({ type: 'tool_started', tool: tool.name, status: 'running' });
			const output = await this.runTool(tool, prompt, decision, evidence, ledger.snapshot(), {
				...context,
				signal
			});
			const outputLimitations = output.limitations || [];
			limitations.push(...outputLimitations);
			if (output.answer) toolAnswers.push(output.answer);
			evidence.splice(0, evidence.length, ...dedupeEvidence([...evidence, ...(output.evidence || [])]));
			toolCalls.push({
				name: tool.name,
				status: output.status,
				limitations: outputLimitations,
				evidence_count: output.evidence?.length || 0
			});
			context.onToolEvent?.({
				type: 'tool_completed',
				tool: tool.name,
				status: output.status,
				detail: outputLimitations.join('; '),
				evidence: output.evidence || []
			});

			if (shouldStopAfterTool(decision, tool.name, evidence, toolCalls, output, this.config.enabled_tools)) {
				stoppedReason = stopReasonAfterTool(decision, output, evidence);
				break;
			}
		}

		if (evidenceHasBlockingLimitation(evidence) && !limitations.some((item) => /blocked|unavailable/i.test(item))) {
			limitations.push('One or more sources were blocked or unavailable.');
		}
		if (!toolCalls.length && decision.tools_to_use.length) {
			limitations.push('No selected tools were run.');
		}

		const budget = ledger.snapshot();
		return {
			prompt,
			decision,
			evidence,
			final_answer: generateFinalAnswer({
				prompt,
				decision,
				evidence,
				limitations,
				budget,
				toolAnswers,
				outputStyle: context.outputStyle
			}),
			limitations: [...new Set(limitations.filter(Boolean))],
			tool_calls: toolCalls,
			budget,
			stopped_reason: stoppedReason
		};
	}

	private async runTool(
		tool: NewsroomTool,
		prompt: string,
		decision: RouteDecision,
		evidence: EvidenceObject[],
		budget: ToolBudgetSnapshot,
		context: NewsroomAgentRunContext
	): Promise<ToolRunOutput> {
		const toolContext: ToolRunContext = {
				prompt,
				decision,
				config: this.config,
				evidence,
				budget,
				repository: context.repository || this.options.repository,
				runId: context.runId,
				jobId: context.jobId,
				openAiApiKey: context.openAiApiKey || this.options.openAiApiKey,
				trigger: context.trigger,
				signal: context.signal
			};
		try {
			return await tool.run(inputForTool(tool.name, prompt, evidence), toolContext);
		} catch (err) {
			return {
				status: 'error',
				limitations: [`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`]
			};
		}
	}
}

function inputForTool(name: string, prompt: string, evidence: EvidenceObject[]): unknown {
	if (name === 'configured_source_monitor') return { query: prompt, urls: urlsFromText(prompt) };
	if (name === 'source_feed_fetcher') return { query: prompt };
	if (name === 'saved_research_reader') return { latest: true };
	if (name === 'openai_web_search') return { query: prompt };
	if (name === 'browser_automation_provider') return { task: prompt, url: firstUrlFromText(prompt) };
	if (name === 'pdf_text_extractor') return { url: firstUrlFromText(prompt), text: undefined };
	if (name === 'newsroom_brief_generator') return { prompt, evidence };
	return { prompt, evidence };
}

function shouldStopAfterTool(
	decision: RouteDecision,
	toolName: string,
	evidence: EvidenceObject[],
	toolCalls: AgentToolCallRecord[],
	output: ToolRunOutput,
	enabledTools: string[]
): boolean {
	if (
		(output.status === 'blocked' || output.status === 'unavailable' || output.status === 'error') &&
		shouldTryWebSearchFallback(decision, toolName, evidence, toolCalls, enabledTools)
	) {
		return false;
	}
	if (output.status === 'blocked') return true;
	if (
		output.status === 'error' &&
		decision.selected_mode !== 'hybrid_research' &&
		!evidence.some(isUsableEvidence)
	) {
		return true;
	}
	if (
		output.status === 'unavailable' &&
		decision.selected_mode !== 'hybrid_research' &&
		!evidence.some(isUsableEvidence)
	) {
		return true;
	}
	if (
		decision.selected_mode === 'source_monitor' &&
		!evidence.some(isUsableEvidence) &&
		!enabledTools.includes(NEWSROOM_TOOL_NAMES.webSearch)
	) {
		return true;
	}
	if (decision.selected_mode === 'hybrid_research') {
		const ranSourceTool = toolCalls.some((call) =>
			['configured_source_monitor', 'source_feed_fetcher'].includes(call.name)
		);
		const ranWebSearch = toolCalls.some((call) => call.name === 'openai_web_search');
		return ranSourceTool && ranWebSearch && hasEnoughEvidence(evidence, decision.selected_mode);
	}
	if (toolName === 'newsroom_brief_generator') return true;
	return hasEnoughEvidence(evidence, decision.selected_mode);
}

function stopReasonAfterTool(
	decision: RouteDecision,
	output: ToolRunOutput,
	evidence: EvidenceObject[]
): string {
	if (output.status === 'blocked') return 'source is blocked or requires interaction/login/paywall access';
	if (output.status === 'unavailable') return 'source or provider unavailable';
	if (hasEnoughEvidence(evidence, decision.selected_mode)) return 'enough evidence exists to answer';
	return 'more research is unlikely to materially improve the answer';
}

function hasEnoughEvidence(evidence: EvidenceObject[], mode: RouteDecision['selected_mode']): boolean {
	const useful = evidence.filter(isUsableEvidence);
	if (mode === 'web_search') return useful.length >= 1;
	if (mode === 'hybrid_research') return useful.length >= 2;
	return useful.length >= 1;
}

function shouldTryWebSearchFallback(
	decision: RouteDecision,
	toolName: string,
	evidence: EvidenceObject[],
	toolCalls: AgentToolCallRecord[],
	enabledTools: string[]
): boolean {
	if (toolName === NEWSROOM_TOOL_NAMES.webSearch) return false;
	if (!decision.tools_to_use.includes(NEWSROOM_TOOL_NAMES.webSearch)) return false;
	if (!enabledTools.includes(NEWSROOM_TOOL_NAMES.webSearch)) return false;
	if (toolCalls.some((call) => call.name === NEWSROOM_TOOL_NAMES.webSearch)) return false;
	return !evidence.some(isUsableEvidence);
}

function combinedSignal(signal: AbortSignal | undefined, maxRuntimeSeconds: number): AbortSignal {
	const timeout = AbortSignal.timeout(Math.max(1, maxRuntimeSeconds) * 1000);
	if (signal && typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
	return timeout;
}

function firstUrlFromText(text: string): string | null {
	return text.match(/https?:\/\/[^\s)>\]]+/i)?.[0]?.replace(/[.,;:!?]+$/, '') || null;
}

function urlsFromText(text: string): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+/gi)) {
		const url = match[0].replace(/[.,;:!?]+$/, '');
		if (!seen.has(url)) {
			seen.add(url);
			urls.push(url);
		}
	}
	return urls;
}
