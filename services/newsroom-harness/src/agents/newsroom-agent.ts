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
import { resolveModelPolicy, type ModelPolicyDecision } from './model-policy.js';
import {
	defaultStepLabel,
	planFromRoute,
	planResearchSteps,
	readingLabelForUrl,
	type PlannerFn,
	type ResearchPlan
} from './planner.js';
import { NEWSROOM_TOOL_NAMES, routeNewsroomRequest, type RouteDecision } from './router.js';
import type { NewsroomTool, ToolRegistry, ToolRunContext, ToolRunOutput } from './tools.js';
import type { ModelProvider } from '../util/openai-complete.js';
import type { DocumentContext, NewsroomContext } from '@newscraft/shared';

export interface NewsroomAgentRunContext {
	repository?: HarnessRepository;
	runId?: string;
	jobId?: string;
	modelProvider?: ModelProvider;
	modelApiKey?: string;
	openAiApiKey?: string;
	trigger?: 'manual' | 'schedule' | 'test';
	newsroomContext?: NewsroomContext;
	documents?: DocumentContext[];
	signal?: AbortSignal;
	outputStyle?: 'report' | 'chat';
	/** Current user request used for routing when prompt also carries system/time/context text. */
	routingPrompt?: string;
	/** Force the model planner for diagnostics/eval comparisons. */
	forcePlanner?: boolean;
	onToolEvent?: (event: AgentToolEvent) => void;
	/** Live answer-text deltas, forwarded from the first answer-producing tool. */
	onAnswerDelta?: (delta: string) => void;
	/** Full plan snapshot whenever a step is added or changes status. */
	onPlanEvent?: (event: AgentPlanEvent) => void;
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
	/** The plan step id this event originated from, if any. */
	stepId?: string;
	status?: string;
	detail?: string;
	evidence?: EvidenceObject[];
}

export type AgentPlanStepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface AgentPlanStepEvent {
	id: string;
	tool: string;
	label: string;
	status: AgentPlanStepStatus;
	detail?: string;
}

export interface AgentPlanEvent {
	source: 'model' | 'router';
	steps: AgentPlanStepEvent[];
}

export interface NewsroomAgentRunResult {
	prompt: string;
	decision: RouteDecision;
	plan: AgentPlanEvent;
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
	modelProvider?: ModelProvider;
	modelApiKey?: string;
	openAiApiKey?: string;
	/** Planner override, mainly for tests. Defaults to the model planner. */
	planner?: PlannerFn;
}

interface QueuedStep {
	id: string;
	tool: string;
	input: string;
	label: string;
	status: AgentPlanStepStatus;
	detail?: string;
}

/** Tools whose failure should trigger a broad web-search fallback. */
const WEB_SEARCH_FALLBACK_TOOLS = new Set<string>([
	NEWSROOM_TOOL_NAMES.sourceMonitor,
	NEWSROOM_TOOL_NAMES.sourceFeedFetcher,
	NEWSROOM_TOOL_NAMES.urlFetchRead,
	NEWSROOM_TOOL_NAMES.pdfTextExtractor
]);
const MAX_FOLLOW_UP_FETCHES = 2;
const PLANNER_TIMEOUT_MS = 10_000;

export class DisciplinedNewsroomAgent {
	private readonly config: NewsroomAgentConfig;
	private readonly registry: ToolRegistry;

	constructor(private readonly options: DisciplinedNewsroomAgentOptions = {}) {
		this.config = createNewsroomAgentConfig(options.config);
		this.registry = options.registry || createDefaultToolRegistry();
	}

	async run(prompt: string, context: NewsroomAgentRunContext = {}): Promise<NewsroomAgentRunResult> {
		const routingPrompt = context.routingPrompt?.trim() || prompt;
		let decision = routeNewsroomRequest(routingPrompt, {
			default_tool_budget: this.config.default_tool_budget
		});
		if (context.documents?.length) decision = documentRouteDecision(decision, routingPrompt);
		const ledger = new ToolBudgetLedger(
			mergeToolBudget({
				...this.config.default_tool_budget,
				...decision.tool_budget
			})
		);
		const evidence: EvidenceObject[] = [];
		const limitations: string[] = [];
		const toolAnswers: string[] = [];
		const toolCalls: AgentToolCallRecord[] = [];
		let answerStreamUsed = false;
		const forwardAnswerDelta = context.onAnswerDelta
			? (delta: string) => {
					answerStreamUsed = true;
					context.onAnswerDelta?.(delta);
				}
			: undefined;

		if (
			decision.selected_mode === 'answer_from_memory' ||
			decision.selected_mode === 'clarification_needed' ||
			decision.selected_mode === 'direct_answer'
		) {
			const budget = ledger.snapshot();
			return {
				prompt,
				decision,
				plan: { source: 'router', steps: [] },
				evidence,
				final_answer: generateFinalAnswer({
					prompt: routingPrompt,
					decision,
					evidence,
					limitations,
					budget,
					outputStyle: context.outputStyle
				}),
				limitations,
				tool_calls: toolCalls,
				budget,
				stopped_reason: decision.selected_mode
			};
		}

		const signal = combinedSignal(context.signal, decision.tool_budget.max_runtime_seconds);
		const plan = await this.resolvePlan(routingPrompt, decision, context, signal);
		const queue: QueuedStep[] = plan.steps.map((step, index) => ({
			id: `step_${index + 1}`,
			tool: step.tool,
			input: step.input,
			label: step.label,
			status: 'pending'
		}));
		const emitPlan = () => context.onPlanEvent?.(planEvent(plan.source, queue));
		emitPlan();

		let stoppedReason = '';
		let followUpFetches = 0;
		let lastOutput: ToolRunOutput | null = null;
		let index = 0;
		while (index < queue.length) {
			const step = queue[index];
			index += 1;
			if (signal.aborted || ledger.isRuntimeExhausted()) {
				stoppedReason = 'max_runtime_seconds exhausted';
				limitations.push(stoppedReason);
				skipStep(step, 'Research stopped before completion.');
				skipRemaining(queue, index, 'Research stopped before completion.');
				emitPlan();
				break;
			}
			if (!this.config.enabled_tools.includes(step.tool)) {
				const reason = `Tool disabled by harness config: ${step.tool}`;
				const publicReason = 'This research step is not available.';
				limitations.push(reason);
				toolCalls.push({ name: step.tool, status: 'skipped', limitations: [reason], evidence_count: 0 });
				context.onToolEvent?.({ type: 'tool_skipped', tool: step.tool, stepId: step.id, detail: publicReason });
				skipStep(step, publicReason);
				emitPlan();
				continue;
			}
			const tool = this.registry.get(step.tool);
			if (!tool) {
				const reason = `Tool is not registered: ${step.tool}`;
				const publicReason = 'This research step is not available.';
				limitations.push(reason);
				toolCalls.push({ name: step.tool, status: 'skipped', limitations: [reason], evidence_count: 0 });
				context.onToolEvent?.({ type: 'tool_skipped', tool: step.tool, stepId: step.id, detail: publicReason });
				skipStep(step, publicReason);
				emitPlan();
				continue;
			}
			const budgetKind = budgetKindForToolCategory(tool.category);
			const allowed = ledger.canUse(budgetKind);
			if (!allowed.ok) {
				stoppedReason = allowed.reason;
				limitations.push(allowed.reason);
				skipStep(step, 'Research limit reached.');
				skipRemaining(queue, index, 'Research limit reached.');
				emitPlan();
				break;
			}

			ledger.consume(budgetKind);
			step.status = 'running';
			emitPlan();
			context.onToolEvent?.({ type: 'tool_started', tool: tool.name, stepId: step.id, status: 'running', detail: step.label });
			const output = await this.runTool(tool, prompt, decision, evidence, ledger.snapshot(), {
				...context,
				signal,
				// Only one tool may stream answer text: the final answer uses the
				// first non-empty tool answer, so later answers never reach the user
				// verbatim, and a second stream after a failed one would garble output.
				onAnswerDelta: toolAnswers.length === 0 && !answerStreamUsed ? forwardAnswerDelta : undefined
			}, step.input);
			lastOutput = output;
			const outputLimitations = output.limitations || [];
			const publicDetail = output.status === 'ok' ? undefined : publicStepFailureDetail(outputLimitations);
			limitations.push(...outputLimitations);
			if (output.answer) toolAnswers.push(output.answer);
			evidence.splice(0, evidence.length, ...dedupeEvidence([...evidence, ...(output.evidence || [])]));
			toolCalls.push({
				name: tool.name,
				status: output.status,
				limitations: outputLimitations,
				evidence_count: output.evidence?.length || 0
			});
			step.status = output.status === 'ok' ? 'ok' : 'failed';
			step.detail = publicDetail;
			context.onToolEvent?.({
				type: 'tool_completed',
				tool: tool.name,
				stepId: step.id,
				status: output.status,
				detail: publicDetail,
				evidence: output.evidence || []
			});

			followUpFetches += this.queueFollowUps(queue, step, output, evidence, ledger, context, followUpFetches);
			emitPlan();

			if (step.tool === NEWSROOM_TOOL_NAMES.briefGenerator) break;
			if (output.status === 'blocked' && !hasPendingSteps(queue, index)) {
				stoppedReason = 'source is blocked or requires interaction/login/paywall access';
				break;
			}
		}

		if (evidenceHasBlockingLimitation(evidence) && !limitations.some((item) => /blocked|unavailable/i.test(item))) {
			limitations.push('One or more sources were blocked or unavailable.');
		}
		if (!toolCalls.length && plan.steps.length) {
			limitations.push('No selected tools were run.');
		}

		const budget = ledger.snapshot();
		return {
			prompt,
			decision,
			plan: planEvent(plan.source, queue),
			evidence,
			final_answer: generateFinalAnswer({
				prompt: routingPrompt,
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
			stopped_reason: stoppedReason || completionStopReason(decision, lastOutput, evidence)
		};
	}

	/**
	 * Plan the run: a model planner proposes concrete steps when allowed; the
	 * regex router's decision is the deterministic fallback and stays the spine
	 * for budgets and answer generation either way.
	 */
	private async resolvePlan(
		prompt: string,
		decision: RouteDecision,
		context: NewsroomAgentRunContext,
		signal: AbortSignal
	): Promise<ResearchPlan> {
		const routedPlan = planFromRoute(decision, prompt);
		const fallback = context.forcePlanner
			? routedPlan
			: singleCallChatFollowupPlan(routedPlan, prompt, decision, context);
		const provider = this.modelProvider(context);
		const apiKey =
			context.modelApiKey ||
			this.options.modelApiKey ||
			(provider === 'openai' ? context.openAiApiKey || this.options.openAiApiKey : '');
		if (
			!this.config.planner_enabled ||
			!apiKey ||
			!fallback.steps.length ||
			(!context.forcePlanner && usesSingleCallChatPlan(fallback, context))
		) {
			return fallback;
		}
		const policy = resolveModelPolicy(this.config.model_policy, 'interactive_chat', { trigger: context.trigger });
		this.appendPlannerEvent(context, policy.allowed ? 'model.call.selected' : 'model.call.skipped', {
			task: policy.task,
			tier: policy.tier,
			model: policy.model,
			reason: policy.reason,
			trigger: policy.trigger
		}, policy);
		if (!policy.allowed || !policy.model) return fallback;

		const planner = this.options.planner || planResearchSteps;
		const documentOnly = Boolean(context.documents?.length) && !requestsExternalCorroboration(prompt);
		const allowedPlannerTools: ReadonlySet<string> | null = documentOnly
			? new Set([NEWSROOM_TOOL_NAMES.pdfTextExtractor])
			: null;
		try {
			const plan = await planner({
				prompt,
				route: decision,
				tools: this.plannerToolCatalog(allowedPlannerTools),
				sourceMonitors: this.config.source_monitors.map((monitor) => ({ name: monitor.name, tags: monitor.tags })),
				maxSteps: Math.max(1, Math.min(4, this.config.default_tool_budget.max_total_tool_calls)),
				apiKey,
				provider,
				model: policy.model,
				reasoningEffort: policy.reasoningEffort,
				signal: plannerSignal(signal)
			});
			if (!plan.steps.length) return fallback;
			if (allowedPlannerTools && plan.steps.some((step) => !allowedPlannerTools.has(step.tool))) {
				throw new Error('planner returned an external tool for a document-only request');
			}
			this.appendPlannerEvent(context, 'plan.created', {
				source: plan.source,
				reason: plan.reason,
				steps: plan.steps.map((step) => ({ tool: step.tool, label: step.label }))
			});
			return plan;
		} catch (err) {
			this.appendPlannerEvent(context, 'plan.fallback', {
				error: err instanceof Error ? err.message : String(err),
				source: 'router'
			});
			return fallback;
		}
	}

	private plannerToolCatalog(
		allowedTools: ReadonlySet<string> | null = null
	): Array<{ name: string; when_to_use: string }> {
		return this.registry
			.list()
			.filter(
				(tool) =>
					this.config.enabled_tools.includes(tool.name) &&
					(!allowedTools || allowedTools.has(tool.name)) &&
					// The browser provider is a stub that always blocks; never plan it.
					tool.name !== NEWSROOM_TOOL_NAMES.browserAutomation
			)
			.map((tool) => ({ name: tool.name, when_to_use: tool.when_to_use }));
	}

	/**
	 * Observe step output and append follow-up steps. Returns how many
	 * follow-up fetches were queued.
	 */
	private queueFollowUps(
		queue: QueuedStep[],
		step: QueuedStep,
		output: ToolRunOutput,
		evidence: EvidenceObject[],
		ledger: ToolBudgetLedger,
		context: NewsroomAgentRunContext,
		followUpFetches: number
	): number {
		let queuedFetches = 0;

		// Source tools failed and nothing usable exists yet → broaden with web search.
		if (
			WEB_SEARCH_FALLBACK_TOOLS.has(step.tool) &&
			!evidence.some(isUsableEvidence) &&
			this.stepCanBeQueued(NEWSROOM_TOOL_NAMES.webSearch) &&
			!queue.some((item) => item.tool === NEWSROOM_TOOL_NAMES.webSearch) &&
			ledger.canUse('web_search').ok
		) {
			queue.push({
				id: `step_${queue.length + 1}`,
				tool: NEWSROOM_TOOL_NAMES.webSearch,
				input: '',
				label: defaultStepLabel(NEWSROOM_TOOL_NAMES.webSearch),
				status: 'pending'
			});
		}

		// Research updates need publication dates; chat prioritizes latency, so
		// deep follow-up fetches only run for report-style outputs.
		if (
			context.outputStyle !== 'chat' &&
			step.tool === NEWSROOM_TOOL_NAMES.webSearch &&
			output.status === 'ok' &&
			this.stepCanBeQueued(NEWSROOM_TOOL_NAMES.urlFetchRead)
		) {
			const datedUsable = evidence.filter((item) => isUsableEvidence(item) && item.published_at).length;
			if (datedUsable < 2) {
				const queuedUrls = new Set(queue.map((item) => item.input));
				const candidates = (output.evidence || [])
					.filter(
						(item) =>
							/^https?:\/\//i.test(item.source_url) &&
							!item.published_at &&
							isUsableEvidence(item) &&
							!queuedUrls.has(item.source_url)
					)
					.slice(0, Math.max(0, MAX_FOLLOW_UP_FETCHES - followUpFetches));
				for (const candidate of candidates) {
					if (!ledger.canUse('custom').ok) break;
					queue.push({
						id: `step_${queue.length + 1}`,
						tool: NEWSROOM_TOOL_NAMES.urlFetchRead,
						input: candidate.source_url,
						label: readingLabelForUrl(candidate.source_url),
						status: 'pending'
					});
					queuedFetches += 1;
				}
			}
		}

		return queuedFetches;
	}

	private stepCanBeQueued(toolName: string): boolean {
		return this.config.enabled_tools.includes(toolName) && this.registry.has(toolName);
	}

	private appendPlannerEvent(
		context: NewsroomAgentRunContext,
		kind: string,
		payload: Record<string, unknown>,
		policy?: ModelPolicyDecision
	): void {
		const repository = context.repository || this.options.repository;
		repository?.appendEvent({
			jobId: context.jobId,
			runId: context.runId,
			agent: 'planner',
			kind,
			payload,
			costMetadata:
				policy?.allowed && policy.model
					? {
							provider: this.modelProvider(context),
							model: policy.model,
							task: policy.task,
							estimated: false
						}
					: null
		});
	}

	private async runTool(
		tool: NewsroomTool,
		prompt: string,
		decision: RouteDecision,
		evidence: EvidenceObject[],
		budget: ToolBudgetSnapshot,
		context: NewsroomAgentRunContext,
		stepInput: string
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
			modelProvider: this.modelProvider(context),
			modelApiKey:
				context.modelApiKey ||
				this.options.modelApiKey ||
				(this.modelProvider(context) === 'openai' ? context.openAiApiKey || this.options.openAiApiKey : ''),
			openAiApiKey: context.openAiApiKey || this.options.openAiApiKey,
			trigger: context.trigger,
			newsroomContext: context.newsroomContext,
			documents: context.documents,
			signal: context.signal,
			onAnswerDelta: context.onAnswerDelta
		};
		try {
			const requestPrompt = context.routingPrompt?.trim() || prompt;
			if (
				context.documents?.length &&
				!requestsExternalCorroboration(requestPrompt) &&
				tool.name !== NEWSROOM_TOOL_NAMES.pdfTextExtractor
			) {
				return {
					status: 'blocked',
					limitations: ['External research was not requested for the attached PDF.']
				};
			}
			return await tool.run(inputForTool(tool.name, requestPrompt, evidence, stepInput), toolContext);
		} catch (err) {
			return {
				status: 'error',
				limitations: [`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`]
			};
		}
	}

	private modelProvider(context: NewsroomAgentRunContext): ModelProvider {
		if (context.modelProvider || this.options.modelProvider) return context.modelProvider || this.options.modelProvider || 'openai';
		if (!context.modelApiKey && !this.options.modelApiKey && (context.openAiApiKey || this.options.openAiApiKey)) return 'openai';
		return this.config.model_provider;
	}
}

function documentRouteDecision(base: RouteDecision, prompt: string): RouteDecision {
	const corroborate = requestsExternalCorroboration(prompt);
	return {
		...base,
		selected_mode: corroborate ? 'hybrid_research' : 'custom_tool',
		reason: corroborate
			? 'The request asks to compare attached document evidence with external sources.'
			: 'The request includes attached document evidence.',
		tools_to_use: corroborate
			? [NEWSROOM_TOOL_NAMES.pdfTextExtractor, NEWSROOM_TOOL_NAMES.webSearch]
			: [NEWSROOM_TOOL_NAMES.pdfTextExtractor],
		stop_condition: corroborate
			? 'stop after document evidence and bounded external corroboration are available'
			: 'stop after the attached document evidence is read',
		expected_output: corroborate
			? 'a comparison that separates attached-document claims from external evidence'
			: 'a document-only answer with page citations'
	};
}

function requestsExternalCorroboration(prompt: string): boolean {
	return /\b(verify|corroborate|fact[- ]?check|search (?:the )?web|search externally|external sources?|other outlets?|broader coverage)\b/i.test(
		prompt
	);
}

function inputForTool(name: string, prompt: string, evidence: EvidenceObject[], stepInput = ''): unknown {
	const input = stepInput.trim();
	const focused = input && input !== prompt ? input : '';
	// URL-bearing tools should see URLs from both the planned input and the prompt.
	const combined = focused ? `${focused}\n${prompt}` : prompt;
	if (name === NEWSROOM_TOOL_NAMES.sourceMonitor) return { query: combined, urls: urlsFromText(combined) };
	if (name === NEWSROOM_TOOL_NAMES.sourceFeedFetcher) return { query: combined };
	if (name === NEWSROOM_TOOL_NAMES.researchResultReader) return { latest: true };
	if (name === NEWSROOM_TOOL_NAMES.webSearch) return { query: focused || prompt };
	if (name === NEWSROOM_TOOL_NAMES.urlFetchRead) return { url: firstUrlFromText(focused || prompt) };
	if (name === NEWSROOM_TOOL_NAMES.browserAutomation) return { task: focused || prompt, url: firstUrlFromText(combined) };
	if (name === NEWSROOM_TOOL_NAMES.pdfTextExtractor) return { url: firstUrlFromText(combined), text: undefined };
	if (name === NEWSROOM_TOOL_NAMES.briefGenerator) return { prompt, evidence };
	return { prompt, evidence };
}

function planEvent(source: 'model' | 'router', queue: QueuedStep[]): AgentPlanEvent {
	return {
		source,
		steps: queue.map((step) => ({
			id: step.id,
			tool: step.tool,
			label: step.label,
			status: step.status,
			...(step.detail ? { detail: step.detail } : {})
		}))
	};
}

function skipStep(step: QueuedStep, detail: string): void {
	if (step.status === 'pending' || step.status === 'running') {
		step.status = 'skipped';
		step.detail = detail;
	}
}

function skipRemaining(queue: QueuedStep[], fromIndex: number, detail: string): void {
	for (const step of queue.slice(fromIndex)) skipStep(step, detail);
}

function hasPendingSteps(queue: QueuedStep[], fromIndex: number): boolean {
	return queue.slice(fromIndex).some((step) => step.status === 'pending');
}

function completionStopReason(
	decision: RouteDecision,
	output: ToolRunOutput | null,
	evidence: EvidenceObject[]
): string {
	if (output?.status === 'blocked') return 'source is blocked or requires interaction/login/paywall access';
	if (hasEnoughEvidence(evidence, decision.selected_mode)) return 'enough evidence exists to answer';
	if (output?.status === 'unavailable') return 'source or provider unavailable';
	return 'more research is unlikely to materially improve the answer';
}

function hasEnoughEvidence(evidence: EvidenceObject[], mode: RouteDecision['selected_mode']): boolean {
	const useful = evidence.filter(isUsableEvidence);
	if (mode === 'hybrid_research') return useful.length >= 2;
	return useful.length >= 1;
}

function plannerSignal(signal: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(PLANNER_TIMEOUT_MS);
	if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
	return timeout;
}

function publicStepFailureDetail(limitations: string[]): string | undefined {
	const value = limitations.find((item) => item.trim())?.trim();
	if (!value) return undefined;
	if (/timeout|timed out|interrupted|stream ended early/i.test(value)) {
		return 'The source check ended before it completed.';
	}
	if (/paywall|subscription|login|captcha|blocked|access denied|forbidden/i.test(value)) {
		return 'A source could not be read because access was restricted.';
	}
	if (/no usable|no cited sources|no readable|returned no .*sources?|empty source/i.test(value)) {
		return 'No usable sources were found for this step.';
	}
	if (
		/unavailable|not configured|missing|disabled|not registered|provider|harness|register|api[_ -]?key|http\s*\d{3}|failed|error/i.test(
			value
		)
	) {
		return 'This research step is not available.';
	}
	return undefined;
}

function combinedSignal(signal: AbortSignal | undefined, maxRuntimeSeconds: number): AbortSignal {
	const timeout = AbortSignal.timeout(Math.max(1, maxRuntimeSeconds) * 1000);
	if (signal && typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
	return timeout;
}

function usesSingleCallChatPlan(
	plan: ResearchPlan,
	context: NewsroomAgentRunContext
): boolean {
	return context.outputStyle === 'chat' && plan.steps.length === 1;
}

function singleCallChatFollowupPlan(
	plan: ResearchPlan,
	prompt: string,
	decision: RouteDecision,
	context: NewsroomAgentRunContext
): ResearchPlan {
	if (
		context.outputStyle !== 'chat' ||
		decision.selected_mode !== 'hybrid_research' ||
		!prompt.includes('Recent conversation context for resolving follow-up references:') ||
		/https?:\/\//i.test(prompt)
	) {
		return plan;
	}
	const webSearch = plan.steps.find((step) => step.tool === NEWSROOM_TOOL_NAMES.webSearch);
	return webSearch ? { ...plan, steps: [webSearch] } : plan;
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
