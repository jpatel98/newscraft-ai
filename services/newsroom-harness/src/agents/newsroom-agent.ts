import type { HarnessRepository } from '../db/repository.js';
import { enforceFinalCitationIntegrity, generateFinalAnswer } from './answer.js';
import {
	budgetKindForToolCategory,
	mergeToolBudget,
	ToolBudgetLedger,
	type ToolBudgetSnapshot
} from './budget.js';
import { createDefaultToolRegistry } from './default-tools.js';
import {
	dedupeEvidence,
	evidenceHasBlockingLimitation,
	isUsableEvidence,
	preparePublishableEvidence,
	type EvidenceObject,
	type EvidenceRanking
} from './evidence.js';
import { filterEvidenceForResearchContract } from './research-policy.js';
import {
	buildProducerCoverageLanes,
	coverageOverlap,
	reformulateCoverageQuery,
	type CoverageLane
} from './coverage-planner.js';
import {
	createNewsroomAgentConfig,
	type NewsroomAgentConfig
} from './harness-config.js';
import { formatConversationContext, guardEvidenceForConversation } from './grounded-conversation.js';
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
import {
	deriveResearchRequestContract,
	mergeLatestResearchContract,
	researchContractWithTemporalWindow,
	type ConversationContext,
	type DocumentContext,
	type NewsroomContext,
	type ResearchRequestContract
} from '@newscraft/shared';
import { createNewsroomTemporalContext, isCurrentEventQuery, type NewsroomClock, type NewsroomTemporalContext } from './time-context.js';

export interface NewsroomAgentRunContext {
	repository?: HarnessRepository;
	runId?: string;
	jobId?: string;
	modelProvider?: ModelProvider;
	modelApiKey?: string;
	openAiApiKey?: string;
	perplexityApiKey?: string;
	trigger?: 'manual' | 'schedule' | 'test';
	newsroomContext?: NewsroomContext;
	conversationContext?: ConversationContext;
	documents?: DocumentContext[];
	signal?: AbortSignal;
	outputStyle?: 'report' | 'chat';
	/** Current user request used for routing when prompt also carries system/time/context text. */
	routingPrompt?: string;
	/** Force the model planner for diagnostics/eval comparisons. */
	forcePlanner?: boolean;
	/** One request-owned temporal contract; created from clock when omitted. */
	temporalContext?: NewsroomTemporalContext;
	/** One request-owned latest-turn research contract. */
	researchContract?: ResearchRequestContract;
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
	discoveryLeads?: EvidenceObject[];
	evidenceDiagnostics?: EvidenceRanking[];
	diagnostics?: ToolRunOutput['diagnostics'];
}

export type AgentPlanStepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface AgentPlanStepEvent {
	id: string;
	tool: string;
	label: string;
	status: AgentPlanStepStatus;
	laneId?: string;
	lanePurpose?: string;
	detail?: string;
}

export interface AgentPlanEvent {
	source: 'model' | 'router';
	steps: AgentPlanStepEvent[];
}

export interface NewsroomAgentRunResult {
	prompt: string;
	decision: RouteDecision;
	research_contract?: ResearchRequestContract;
	plan: AgentPlanEvent;
	evidence: EvidenceObject[];
	final_answer: string;
	limitations: string[];
	tool_calls: AgentToolCallRecord[];
	budget: ToolBudgetSnapshot;
	stopped_reason: string;
	discovery_leads?: EvidenceObject[];
}

export interface DisciplinedNewsroomAgentOptions {
	config?: Partial<NewsroomAgentConfig>;
	registry?: ToolRegistry;
	repository?: HarnessRepository;
	modelProvider?: ModelProvider;
	modelApiKey?: string;
	openAiApiKey?: string;
	perplexityApiKey?: string;
	/** Planner override, mainly for tests. Defaults to the model planner. */
	planner?: PlannerFn;
	clock?: NewsroomClock;
}

interface QueuedStep {
	id: string;
	tool: string;
	input: string;
	label: string;
	status: AgentPlanStepStatus;
	detail?: string;
	laneId?: string;
	lanePurpose?: string;
	reformulated?: boolean;
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
		const resolvedRoutingPrompt =
			context.conversationContext?.currentTurn?.resolvedRequest.trim() || routingPrompt;
		const temporalContext = context.temporalContext || createNewsroomTemporalContext({
			now: (this.options.clock || (() => new Date()))(),
			timeZone: context.newsroomContext?.timezone,
			request: resolvedRoutingPrompt
		});
		const legacyTopicContract = context.conversationContext?.activeTopic?.subject
			? deriveResearchRequestContract(context.conversationContext.activeTopic.subject, {
					homeMarket: context.conversationContext.activeTopic.location || context.newsroomContext?.homeMarket,
					timezone: temporalContext.timeZone,
					preserveBaseSubject: false
				})
			: undefined;
		const baseResearchContract =
			context.researchContract ||
			context.conversationContext?.currentTurn?.researchContract ||
			(legacyTopicContract
				? mergeLatestResearchContract(legacyTopicContract, resolvedRoutingPrompt, {
						homeMarket: context.newsroomContext?.homeMarket || context.conversationContext?.activeTopic?.location,
					timezone: temporalContext.timeZone
				})
				: deriveResearchRequestContract(resolvedRoutingPrompt, {
						homeMarket: context.newsroomContext?.homeMarket,
					timezone: temporalContext.timeZone,
					preserveBaseSubject: false
				}));
		const contractWithContinuityLeads = {
			...baseResearchContract,
			referenceUrls: [
				...new Set([
					...baseResearchContract.referenceUrls,
					...(context.conversationContext?.lastSourceBackedAnswer?.leads || []).map((lead) => lead.url)
				])
			]
		};
		const researchContract = researchContractWithTemporalWindow(contractWithContinuityLeads, {
				start: temporalContext.windowStart,
				end: temporalContext.windowEnd,
				timezone: temporalContext.timeZone,
				label: temporalContext.windowLabel
			});
		context = { ...context, temporalContext, researchContract };
		const researchPrompt = documentResearchPrompt(
			groundedResearchPrompt(withKnownLeadReference(resolvedRoutingPrompt, context.conversationContext), context.conversationContext),
			context.documents
		);
		let decision = routeNewsroomRequest(resolvedRoutingPrompt, {
			default_tool_budget: this.config.default_tool_budget
		});
		if (context.documents?.length) decision = documentRouteDecision(decision, researchPrompt);
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
				research_contract: researchContract,
				plan: { source: 'router', steps: [] },
				evidence,
				final_answer: generateFinalAnswer({
					prompt: resolvedRoutingPrompt,
					decision,
					evidence,
					limitations,
					budget,
					outputStyle: context.outputStyle,
					conversationContext: context.conversationContext
				}),
				limitations,
				tool_calls: toolCalls,
				budget,
				stopped_reason: decision.selected_mode
			};
		}

		const signal = combinedSignal(context.signal, decision.tool_budget.max_runtime_seconds);
		const plan = await this.resolvePlan(
			researchPrompt,
			resolvedRoutingPrompt,
			decision,
			context,
			signal
		);
		const queue: QueuedStep[] = plan.steps.map((step, index) => ({
			id: `step_${index + 1}`,
			tool: step.tool,
			input: step.input,
			label: step.label,
			...(step.laneId ? { laneId: step.laneId } : {}),
			...(step.lanePurpose ? { lanePurpose: step.lanePurpose } : {}),
			status: 'pending'
		}));
		const emitPlan = () => context.onPlanEvent?.(planEvent(plan.source, queue));
		emitPlan();

		let stoppedReason = '';
		let followUpFetches = 0;
		let lastOutput: ToolRunOutput | null = null;
		const discoveryLeads: EvidenceObject[] = [];
		const searchedEvidence: EvidenceObject[] = [];
		const coverageLanes = buildProducerCoverageLanes(researchContract, context.newsroomContext, {
			maxLanes: Math.min(6, Math.max(1, this.config.default_tool_budget.max_web_searches))
		});
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
				this.queueWebSearchFallback(queue, step, evidence, ledger);
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
				this.queueWebSearchFallback(queue, step, evidence, ledger);
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
			const rawOutput = await this.runTool(tool, prompt, decision, evidence, ledger.snapshot(), {
				...context,
				signal,
				// Only one tool may stream answer text: the final answer uses the
				// first non-empty tool answer, so later answers never reach the user
				// verbatim, and a second stream after a failed one would garble output.
				onAnswerDelta: toolAnswers.length === 0 && !answerStreamUsed ? forwardAnswerDelta : undefined
			}, step.input);
			const normalizedOutput = context.documents?.length
				? rawOutput
				: rebaseToolOutputCitations(rawOutput, evidence);
			const contractGuarded = applyResearchContractGuard(normalizedOutput, researchContract);
			const conversationGuarded = applyConversationGuard(contractGuarded, context.conversationContext, temporalContext);
			const output = applyTemporalGuard(conversationGuarded, temporalContext, isCurrentEventQuery(resolvedRoutingPrompt));
			lastOutput = output;
			const outputLimitations = output.limitations || [];
			const publicDetail = output.status === 'ok' ? undefined : publicStepFailureDetail(outputLimitations);
			limitations.push(...outputLimitations);
			discoveryLeads.push(...(output.discovery_leads || []));
			if (output.answer) toolAnswers.push(output.answer);
			evidence.splice(0, evidence.length, ...dedupeEvidence([...evidence, ...(output.evidence || [])]));
			const overlapAction = coverageActionForStep(step, output.evidence || [], searchedEvidence, queue, index, coverageLanes, researchContract);
			searchedEvidence.push(...(output.evidence || []));
			toolCalls.push({
				name: tool.name,
				status: output.status,
				limitations: outputLimitations,
				evidence_count: output.evidence?.length || 0
			});
			step.status = output.status === 'ok' ? 'ok' : 'failed';
			step.detail = publicDetail || step.detail;
			context.onToolEvent?.({
				type: 'tool_completed',
				tool: tool.name,
				stepId: step.id,
				status: output.status,
				detail: publicDetail,
				evidence: output.evidence || [],
				discoveryLeads: output.discovery_leads || [],
				evidenceDiagnostics: output.evidence_diagnostics,
				diagnostics: output.diagnostics
			});
			if (overlapAction === 'stop') {
				stoppedReason = 'coverage lanes overlapped after a reformulation; research stopped early';
				skipRemaining(queue, index, 'Coverage was already represented by earlier research lanes.');
				emitPlan();
				break;
			}
			if (
				step.tool === NEWSROOM_TOOL_NAMES.webSearch &&
				shouldStopRepeatedWebSearch(output) &&
				queue.slice(index).some((item) => item.tool === NEWSROOM_TOOL_NAMES.webSearch)
			) {
				stoppedReason = 'live research capability unavailable';
				skipRemaining(queue, index, 'Live research is temporarily unavailable.');
				emitPlan();
				break;
			}

			followUpFetches += this.queueFollowUps(
				queue,
				step,
				normalizedOutput,
				evidence,
				ledger,
				context,
				followUpFetches
			);
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
		const finalGuard = guardEvidenceForConversation(evidence, context.conversationContext, { temporalContext });
		if (finalGuard.excluded.length) {
			evidence.splice(0, evidence.length, ...finalGuard.evidence);
			const groundedAnswers = toolAnswers
				.map((answer) => retainAcceptedCitationClaims(answer, finalGuard.evidence))
				.filter((answer): answer is string => Boolean(answer));
			toolAnswers.splice(0, toolAnswers.length, ...groundedAnswers);
		}
		limitations.push(...finalGuard.limitations);
		const publishable = preparePublishableEvidence(evidence, temporalContext, isCurrentEventQuery(resolvedRoutingPrompt));
		const orderedPublishable = context.documents?.length
			? [
					...publishable.accepted.filter((item) => item.source_kind !== 'user_document'),
					...publishable.accepted.filter((item) => item.source_kind === 'user_document')
				].map((item, index) => ({ ...item, citation_number: index + 1 }))
			: publishable.accepted;
		evidence.splice(0, evidence.length, ...orderedPublishable);
		if (publishable.excluded.length) limitations.push(`${publishable.excluded.length} discovery, hub, unknown-date, or out-of-window source${publishable.excluded.length === 1 ? ' was' : 's were'} excluded from publishable claims.`);
		discoveryLeads.push(...publishable.excluded);
		if (researchContract.requestedItemCount && evidence.length < researchContract.requestedItemCount) {
			limitations.push(
				`Only ${evidence.length} of ${researchContract.requestedItemCount} requested item${researchContract.requestedItemCount === 1 ? '' : 's'} met the contract; returning the verified subset.`
			);
		}
		alignCitationSequence(evidence, toolAnswers);
		if (!toolCalls.length && plan.steps.length) {
			limitations.push('No selected tools were run.');
		}

		const budget = ledger.snapshot();
		let finalAnswer = generateFinalAnswer({
			prompt: resolvedRoutingPrompt,
			decision,
			evidence,
			limitations,
			budget,
			toolAnswers,
			researchStepCount: toolCalls.length,
			outputStyle: context.outputStyle,
			conversationContext: context.conversationContext
			});
			if (context.outputStyle === 'chat') finalAnswer = enforceFinalCitationIntegrity(finalAnswer, evidence);
			markCitedEvidence(evidence, finalAnswer);
			return {
			prompt,
			decision,
			research_contract: researchContract,
			plan: planEvent(plan.source, queue),
			evidence,
			final_answer: finalAnswer,
			limitations: [...new Set(limitations.filter(Boolean))],
			tool_calls: toolCalls,
			budget,
			stopped_reason: stoppedReason || completionStopReason(decision, lastOutput, evidence),
			discovery_leads: dedupeEvidence(discoveryLeads).slice(0, 16)
		};
	}

	/**
	 * Plan the run: a model planner proposes concrete steps when allowed; the
	 * regex router's decision is the deterministic fallback and stays the spine
	 * for budgets and answer generation either way.
	 */
	private async resolvePlan(
		prompt: string,
		currentRequest: string,
		decision: RouteDecision,
		context: NewsroomAgentRunContext,
		signal: AbortSignal
	): Promise<ResearchPlan> {
		const routedPlan = planFromRoute(decision, prompt);
		if (context.documents?.length) {
			// Attached-document requests have a strict evidence order: read the
			// document first, then search only when corroboration was requested.
			return routedPlan;
		}
		if (!context.forcePlanner) {
			const coveragePlan = coverageSweepPlan(
				routedPlan,
				currentRequest,
				context,
				context.researchContract,
				this.config.default_tool_budget.max_web_searches
			);
			if (coveragePlan !== routedPlan) return coveragePlan;
		}
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
		const allowedPlannerTools: ReadonlySet<string> | null = null;
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
					temporalContext: context.temporalContext!,
				researchContract: context.researchContract,
				reasoningEffort: policy.reasoningEffort,
				signal: plannerSignal(signal)
			});
			if (!plan.steps.length) return fallback;
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

		this.queueWebSearchFallback(queue, step, evidence, ledger);

		// Research updates need publication dates. Ordinary chat prioritizes
		// latency, but a current-news chat must read undated discoveries before
		// the freshness guard can accept them.
		if (
			(context.outputStyle !== 'chat' ||
				context.conversationContext?.currentTurn?.freshness === 'current') &&
			step.tool === NEWSROOM_TOOL_NAMES.webSearch &&
			output.status === 'ok' &&
			this.stepCanBeQueued(NEWSROOM_TOOL_NAMES.urlFetchRead)
		) {
			const recoverCurrentEvidence =
				context.conversationContext?.currentTurn?.freshness === 'current' &&
				!evidence.some(isUsableEvidence);
			const datedUsable = evidence.filter((item) => isUsableEvidence(item) && item.published_at).length;
			if (datedUsable < 2) {
				const queuedUrls = new Set(queue.map((item) => item.input));
				const candidates = (output.evidence || [])
					.filter(
						(item) =>
							/^https?:\/\//i.test(item.source_url) &&
							(!item.published_at || recoverCurrentEvidence) &&
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

	private queueWebSearchFallback(
		queue: QueuedStep[],
		step: QueuedStep,
		evidence: EvidenceObject[],
		ledger: ToolBudgetLedger
	): void {
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
			perplexityApiKey: context.perplexityApiKey || this.options.perplexityApiKey,
			trigger: context.trigger,
			newsroomContext: context.newsroomContext,
			temporalContext: context.temporalContext,
			conversationContext: context.conversationContext,
			researchContract: context.researchContract,
			documents: context.documents,
			signal: context.signal,
			onAnswerDelta: context.onAnswerDelta
		};
		try {
			const resolvedCurrentRequest =
				context.conversationContext?.currentTurn?.resolvedRequest.trim() || '';
			const requestPrompt = resolvedCurrentRequest || context.routingPrompt?.trim() || prompt;
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
		if (context.modelProvider || this.options.modelProvider) return context.modelProvider || this.options.modelProvider || 'perplexity';
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

function applyConversationGuard(output: ToolRunOutput, context: ConversationContext | undefined, temporalContext?: NewsroomTemporalContext): ToolRunOutput {
	const guarded = guardEvidenceForConversation(output.evidence || [], context, {
		includeCoverageCompleteness: false,
		temporalContext
	});
	const limitations = [...(output.limitations || []), ...guarded.limitations];
	const rejectedByConversation = guarded.excluded.map((item) => ({
		...item,
		ledger_status: 'rejected' as const,
		temporal_scope: 'discovery' as const,
		rejection_reason: item.rejection_reason || 'wrong subject, entity, location, or time for the conversation'
	}));
	return {
		...output,
		status: output.status === 'ok' && output.evidence?.length && !guarded.evidence.length ? 'unavailable' : output.status,
		evidence: guarded.evidence,
		evidence_diagnostics: guarded.diagnostics,
		answer:
			output.answer && guarded.excluded.length
				? retainAcceptedCitationClaims(output.answer, guarded.evidence)
				: output.answer,
		discovery_leads: dedupeEvidence([...(output.discovery_leads || []), ...rejectedByConversation]),
		limitations
	};
}

function applyResearchContractGuard(
	output: ToolRunOutput,
	contract: ResearchRequestContract | undefined
): ToolRunOutput {
	const guarded = filterEvidenceForResearchContract(output.evidence || [], contract);
	if (!guarded.excluded.length) return output;
	return {
		...output,
		status: output.status === 'ok' && !guarded.accepted.length ? 'unavailable' : output.status,
		evidence: guarded.accepted,
		discovery_leads: dedupeEvidence([...(output.discovery_leads || []), ...guarded.excluded]),
		limitations: [...(output.limitations || []), ...guarded.limitations]
	};
}

function applyTemporalGuard(
	output: ToolRunOutput,
	temporalContext: NewsroomTemporalContext,
	currentRequest: boolean
): ToolRunOutput {
	if (!currentRequest) return output;
	const prepared = preparePublishableEvidence(output.evidence || [], temporalContext, currentRequest);
	if (!prepared.excluded.length) return output;
	const limitations = [
		...(output.limitations || []),
		`${prepared.excluded.length} discovery, hub, or out-of-window source${prepared.excluded.length === 1 ? ' was' : 's were'} excluded from publishable claims.`
	];
	return {
		...output,
		status: output.status,
		evidence: prepared.accepted,
		answer: output.answer,
		discovery_leads: dedupeEvidence([...(output.discovery_leads || []), ...prepared.excluded]),
		limitations
	};
}

function rebaseToolOutputCitations(
	output: ToolRunOutput,
	existingEvidence: EvidenceObject[]
): ToolRunOutput {
	if (!output.evidence?.length) return output;
	const used = new Set(
		existingEvidence
			.map((item) => item.citation_number)
			.filter((number): number is number => Number.isInteger(number) && Number(number) > 0)
	);
	if (!used.size) return output;
	let next = Math.max(...used) + 1;
	const remap = new Map<number, number>();
	const evidence = output.evidence.map((item) => {
		const original = item.citation_number;
		if (!original || !Number.isInteger(original)) return item;
		let replacement = remap.get(original);
		if (!replacement) {
			while (used.has(next)) next += 1;
			replacement = next;
			next += 1;
			used.add(replacement);
			remap.set(original, replacement);
		}
		return { ...item, citation_number: replacement };
	});
	if (!remap.size) return { ...output, evidence };
	return {
		...output,
		evidence,
		answer: output.answer
			? output.answer.replace(/\[(\d+)\]/g, (marker, rawNumber: string) => {
					const replacement = remap.get(Number(rawNumber));
					return replacement ? `[${replacement}]` : marker;
				})
			: output.answer
	};
}

function retainAcceptedCitationClaims(answer: string, evidence: EvidenceObject[]): string | undefined {
	const accepted = new Set(
		evidence
			.map((item) => item.citation_number)
			.filter((number): number is number => number != null)
	);
	if (!accepted.size) return undefined;

	const markers = citationNumbersIn(answer);
	if (
		markers.length &&
		markers.every((number) => accepted.has(number)) &&
		isSubstantiveCitedClaim(answer)
	) {
		return answer.trim();
	}
	if (!markers.length) return undefined;

	const claims = splitCitedClaims(answer)
		.map((claim) => claim.trim())
		.filter(Boolean)
		.filter((claim) => {
			const claimMarkers = citationNumbersIn(claim);
			return (
				claimMarkers.length > 0 &&
				claimMarkers.every((number) => accepted.has(number)) &&
				isSubstantiveCitedClaim(claim)
			);
		});
	return claims.length ? claims.join('\n\n') : undefined;
}

function splitCitedClaims(value: string): string[] {
	return value
		.replace(/((?:\s*\[\d+\])+(?:[.!?])?)(?:\s+|$)/g, '$1\n')
		.split(/\n+/);
}

function isSubstantiveCitedClaim(value: string): boolean {
	const prose = value
		.replace(/\[\d+\]/g, ' ')
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, ' ')
		.replace(/[*_#`()]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const words = prose.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’.-]*\b/gu)?.length ?? 0;
	return prose.length >= 24 && words >= 5;
}

function citationNumbersIn(value: string): number[] {
	return [...value.matchAll(/\[(\d+)\]/g)]
		.map((match) => Number(match[1]))
		.filter((number) => Number.isInteger(number) && number > 0);
}

function markCitedEvidence(evidence: EvidenceObject[], answer: string): void {
	const cited = new Set(citationNumbersIn(answer));
	for (const item of evidence) {
		if (item.citation_number && cited.has(item.citation_number)) item.ledger_status = 'cited';
		else if (item.ledger_status !== 'rejected') item.ledger_status = 'accepted';
	}
}

function coverageActionForStep(
	step: QueuedStep,
	candidates: EvidenceObject[],
	previous: EvidenceObject[],
	queue: QueuedStep[],
	fromIndex: number,
	lanes: CoverageLane[],
	contract: ResearchRequestContract
): 'continue' | 'stop' {
	if (step.tool !== NEWSROOM_TOOL_NAMES.webSearch || !step.laneId || !candidates.length || !previous.length) return 'continue';
	const overlap = coverageOverlap(candidates, previous);
	if (overlap.candidateCount === 0 || overlap.ratio < 0.75) return 'continue';
	if (step.reformulated) return 'stop';
	const nextLane = queue.slice(fromIndex).find(
		(item) => item.status === 'pending' && item.tool === NEWSROOM_TOOL_NAMES.webSearch && item.laneId
	);
	if (!nextLane) return 'stop';
	const lane = lanes.find((candidate) => candidate.id === nextLane.laneId);
	if (!lane || nextLane.reformulated) return 'stop';
	nextLane.input = reformulateCoverageQuery(
		lane,
		contract,
		`${overlap.candidateCount} candidate URLs overlapped earlier coverage; target a source purpose not represented yet`
	);
	nextLane.reformulated = true;
	nextLane.detail = 'Reformulated around an uncovered source lane after overlapping results.';
	return 'continue';
}

function alignCitationSequence(evidence: EvidenceObject[], toolAnswers: string[]): void {
	const usedNumbers = new Set(
		evidence
			.map((item) => item.citation_number)
			.filter((number): number is number => number != null)
	);
	let nextNumber = 1;
	for (const item of evidence) {
		if (item.citation_number != null) continue;
		while (usedNumbers.has(nextNumber)) nextNumber += 1;
		item.citation_number = nextNumber;
		usedNumbers.add(nextNumber);
		nextNumber += 1;
	}
	const accepted = new Set(
		evidence
			.map((item) => item.citation_number)
			.filter((number): number is number => number != null)
	);
	for (let index = toolAnswers.length - 1; index >= 0; index -= 1) {
		const markers = citationNumbersIn(toolAnswers[index]);
		if (!markers.some((number) => !accepted.has(number))) continue;
		const grounded = retainAcceptedCitationClaims(toolAnswers[index], evidence);
		if (grounded) toolAnswers[index] = grounded;
		else toolAnswers.splice(index, 1);
	}

	const remap = new Map<number, number>();
	for (const item of evidence) {
		const original = item.citation_number;
		if (original == null) continue;
		if (!remap.has(original)) remap.set(original, remap.size + 1);
		item.citation_number = remap.get(original);
	}
	for (let index = 0; index < toolAnswers.length; index += 1) {
		toolAnswers[index] = toolAnswers[index].replace(/\[(\d+)\]/g, (marker, rawNumber: string) => {
			const next = remap.get(Number(rawNumber));
			return next ? `[${next}]` : marker;
		});
	}
}

function groundedResearchPrompt(prompt: string, context: ConversationContext | undefined): string {
	const grounded = formatConversationContext(context);
	if (!grounded) return prompt;
	return [
		'Current user request:',
		prompt,
		'',
		grounded,
		'',
		'Resolve follow-ups only from this conversation state. The current user request is authoritative; do not substitute a different story, location, sport, alert, or outlet.'
	].join('\n');
}

function withKnownLeadReference(prompt: string, context: ConversationContext | undefined): string {
	if (/https?:\/\//i.test(prompt)) return prompt;
	const leads = context?.lastSourceBackedAnswer?.leads || [];
	if (!leads.length) return prompt;
	const words = new Set((prompt.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((word) => !['the', 'this', 'that', 'lead', 'story', 'one'].includes(word)));
	const scored = leads
		.map((lead) => {
			const text = `${lead.title} ${lead.domain}`.toLowerCase();
			const score = [...words].reduce((total, word) => total + (text.includes(word) ? 1 : 0), 0);
			return { lead, score };
		})
		.sort((left, right) => right.score - left.score);
	const match = scored[0];
	if (!match || (match.score === 0 && leads.length > 1)) return prompt;
	return `${prompt}\n\nContinuity source lead to resolve exactly if it matches the request: ${match.lead.url}`;
}

function documentResearchPrompt(prompt: string, documents: DocumentContext[] | undefined): string {
	if (!documents?.length) return prompt;
	const documentText = documents
		.flatMap((document) => [
			`Attached document: ${document.filename}`,
			...document.pages.map((page) => `Page ${page.pageNumber}: ${page.text}`)
		])
		.join('\n');
	return `${prompt}\n\n${documentText}`;
}

function requestsExternalCorroboration(prompt: string): boolean {
	if (
		/\b(?:do not|don't|without)\s+(?:verify(?:ing)?|corroborat(?:e|ing)|search(?:ing)?)\b[\s\S]{0,40}\b(?:externally|external|web|outside)\b/i.test(
			prompt
		)
	) {
		return false;
	}
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
			...(step.laneId ? { laneId: step.laneId } : {}),
			...(step.lanePurpose ? { lanePurpose: step.lanePurpose } : {}),
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
	if (/could not be opened directly/i.test(value)) {
		return 'This research step is not available.';
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

function coverageSweepPlan(
	plan: ResearchPlan,
	currentRequest: string,
	context: NewsroomAgentRunContext,
	contract?: ResearchRequestContract,
	maxWebSearches = 4
): ResearchPlan {
	const effectiveContract = contract || context.researchContract;
	const namedOutletOnly = isNamedOutletOnlyRequest(currentRequest, effectiveContract);
	if (context.outputStyle !== 'chat' || (!namedOutletOnly && !isBroadNewsCoverageRequest(currentRequest, context, effectiveContract))) {
		return plan;
	}
	if (!effectiveContract) return plan;
	const lanes = buildProducerCoverageLanes(effectiveContract, context.newsroomContext, {
		maxLanes: Math.min(4, Math.max(1, maxWebSearches)),
		namedOnly: namedOutletOnly
	});
	if (!lanes.length) return plan;
	return {
		source: 'router',
		reason: 'A broad current-news assignment needs independent coverage lanes before one final synthesis.',
		steps: lanes.map((lane) => ({
			tool: NEWSROOM_TOOL_NAMES.webSearch,
			input: lane.query,
			label: lane.label,
			laneId: lane.id,
			lanePurpose: `${lane.sourcePurpose}: ${lane.purpose}`
		}))
	};
}

function isNamedOutletOnlyRequest(currentRequest: string, contract?: ResearchRequestContract): boolean {
	if (!contract || (!contract.namedOutlets.length && !contract.namedDomains.length)) return false;
	return !/\b(?:briefing|roundup|headlines?|stories|items?|assignment desk|news)\b/i.test(currentRequest);
}

function shouldStopRepeatedWebSearch(output: ToolRunOutput): boolean {
	if (output.status !== 'error' && output.status !== 'unavailable') return false;
	const attempts = output.diagnostics?.attempts || [];
	const terminalCategory = attempts.at(-1)?.failureCategory;
	if (
		terminalCategory &&
		!['no_usable_sources', 'stream_interrupted', 'timeout', 'network'].includes(terminalCategory)
	) {
		return true;
	}
	return (output.limitations || []).some((item) =>
		/not configured|api[_ -]?key is missing|authentication|unauthorized|forbidden/i.test(item)
	);
}

function isBroadNewsCoverageRequest(
	currentRequest: string,
	context: NewsroomAgentRunContext,
	contract?: ResearchRequestContract
): boolean {
	const subject = contract?.subject || context.conversationContext?.activeTopic?.subject || '';
	const combined = `${subject}\n${currentRequest}`;
	const asksForNews =
		/\b(?:news|headlines|top stories|news roundup|briefing|assignment desk|stories|headlines|what(?:'s| is) happening)\b/i.test(combined);
	const asksForCurrentCoverage =
		/\b(?:latest|today|tonight|current|breaking|newest|this morning|this afternoon)\b/i.test(
			combined
		) ||
		context.conversationContext?.activeTopic?.relevantDate === 'current' ||
		context.conversationContext?.activeTopic?.relevantDate === 'latest' ||
		contract?.temporalWindow.kind === 'current' ||
		contract?.temporalWindow.kind === 'relative';
	return asksForNews && asksForCurrentCoverage;
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
