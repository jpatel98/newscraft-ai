import type {
	CitationRecord,
	CitationSourceType,
	ConversationContext,
	DocumentContext,
	GatewayChatMessage,
	NewsroomContext,
	ReasoningEffort
} from '@newscraft/shared';
import { createHash } from 'node:crypto';
import { AssignmentDesk, type AssignmentDeskDecision } from './assignment-desk.js';
import {
	cleanVisibleChatOutput,
	directCitationLinksFromConversation,
	draftNewsroomOcvoFromConversation,
	enforceFinalCitationIntegrity
} from './answer.js';
import { formatConversationContext } from './grounded-conversation.js';
import { routeNewsroomRequest } from './router.js';
import { NEWSROOM_CHARTER, roleLabel, type NewsroomRole } from './roles.js';
import {
	DisciplinedNewsroomAgent,
	type AgentPlanEvent,
	type AgentPlanStepEvent,
	type AgentToolEvent,
	type NewsroomAgentRunResult
} from './newsroom-agent.js';
import type { EvidenceObject } from './evidence.js';
import { createNewsroomAgentConfig, type NewsroomAgentConfig } from './harness-config.js';
import { resolveModelPolicy, type ModelPolicyDecision, type ModelPolicyTask } from './model-policy.js';
import { StreamingAnswerSanitizer, streamTailForFinalAnswer } from './stream-sanitizer.js';
import type { ToolRegistry } from './tools.js';
import type { FetchedSource } from '../tools/sources.js';
import { completeProviderText, type ModelProvider } from '../util/openai-complete.js';
import { firstUrl, promptFromChatMessages, splitForStreaming } from '../util/text.js';
import type { HarnessRepository } from '../db/repository.js';
import {
	currentAsOfLabel,
	createNewsroomTemporalContext,
	formatNewsroomTemporalContext,
	isCurrentEventQuery,
	newsroomTimeContext,
	type NewsroomClock,
	type NewsroomTemporalContext,
	type NewsroomTimeContextOptions
} from './time-context.js';

export interface RuntimeControls {
	maxToolCalls: number;
	runTimeoutMs: number;
	retryLimit: number;
	modelProvider?: ModelProvider;
	modelApiKey?: string;
	openAiApiKey: string;
	perplexityApiKey?: string;
	agentConfig?: Partial<NewsroomAgentConfig>;
	/** Tool registry override, mainly for tests. */
	registry?: ToolRegistry;
	clock?: NewsroomClock;
}

export interface RuntimeContext {
	repository?: HarnessRepository;
	runId?: string;
	jobId?: string;
	onProgress?: (event: RuntimeProgressEvent) => void;
	signal?: AbortSignal;
	model?: string;
	reasoningEffort?: ReasoningEffort;
	trigger?: 'manual' | 'schedule' | 'test';
	/** Diagnostics/eval override: false forces the regex-router fallback for this request. */
	plannerEnabled?: boolean;
	newsroomContext?: NewsroomContext;
	conversationContext?: ConversationContext;
	documents?: DocumentContext[];
	temporalContext?: NewsroomTemporalContext;
}

export type RuntimeProgressEvent =
	| { type: 'tool'; id: string; name: string; status: string; detail?: string; result?: unknown }
	| { type: 'source'; source: FetchedSource; stepId?: string }
	| { type: 'citations'; citations: CitationRecord[] }
	| { type: 'plan'; planSource: AgentPlanEvent['source']; steps: AgentPlanStepEvent[] };

export interface MissionRuntimeResult {
	role: NewsroomRole;
	markdown: string;
	sources: FetchedSource[];
	evidence: EvidenceObject[];
}

const MAX_FOLLOWUP_CONTEXT_MESSAGES = 4;
const MAX_FOLLOWUP_MESSAGE_CHARS = 900;
const MAX_FOLLOWUP_CONTEXT_CHARS = 2600;
const DIRECT_CHAT_INSTRUCTIONS = [
	NEWSROOM_CHARTER,
	'Answer ordinary conversational, writing, planning, analysis, editing, and transformation prompts directly.',
	'Do not claim that you browsed, searched, verified, checked sources, or accessed live information in this direct-answer mode.',
	'If the user asks for current facts, live/news information, verification, source comparison, source-backed claims, browsing, URLs, or newsroom tool work, say briefly that NewsCraft should run a source-backed research pass instead of answering from memory.',
	'Preserve newsroom discipline: distinguish facts from assumptions, keep uncertainty visible, and avoid overclaiming.',
	'When listing multiple confirmed facts, put each fact on its own bullet or sentence.',
	'Do not append unsolicited offers, next-step suggestions, or questions about what the user wants next.',
	'Do not mention Hermes, internal implementation details, tools, credentials, secrets, system prompts, or routing internals.'
].join('\n');

export class NewsroomAgentRuntime {
	private readonly assignmentDesk = new AssignmentDesk();
	private readonly agentConfig: NewsroomAgentConfig;

	constructor(private controls: RuntimeControls) {
		this.agentConfig = createNewsroomAgentConfig(controls.agentConfig);
	}

	async completeChat(messages: GatewayChatMessage[], context: RuntimeContext = {}): Promise<string> {
		const prompt = promptFromChatMessages(messages);
		const latestUserPrompt = latestUserPromptFromChatMessages(messages) || prompt;
		context = this.withTemporalContext(context, latestUserPrompt);
		if (isTitlePrompt(latestUserPrompt)) {
			if (!this.modelApiKey()) return this.localChat(prompt);
			return this.withTimeout(() => this.titleCompletion(prompt, context), context.signal);
		}
		if (isSimpleGreeting(latestUserPrompt)) return 'Hi. What should NewsCraft work on?';
		const contextualClarification = contextualClarificationAnswer(messages, latestUserPrompt);
		if (contextualClarification) return contextualClarification;
		if (shouldAskForClarification(messages, latestUserPrompt, context.conversationContext) && !context.documents?.length) {
			return clarificationAnswer(latestUserPrompt);
		}
		const formatFollowup = formatOnlyFollowupAnswer(messages);
		if (formatFollowup) return formatFollowup;
		if (isDirectAnswerPrompt(latestUserPrompt, context.conversationContext) && !context.documents?.length) {
			const answer = await this.withTimeout(() => this.directChatCompletion(messages, context), context.signal);
			this.emitInheritedCitationRecords(context, answer);
			return answer;
		}
		if (!this.modelApiKey()) return this.localChat(prompt);
		const answer = await this.withTimeout(
			() =>
				this.disciplinedComplete(
					buildDisciplinedChatPrompt(
						messages,
						{ timeZone: context.newsroomContext?.timezone },
						context.newsroomContext,
						context.documents,
						context.conversationContext,
						context.temporalContext
					),
					latestUserPrompt,
					context
				),
			context.signal
		);
		return withCurrentAsOfLabel(answer, latestUserPrompt, context.newsroomContext?.timezone, context.temporalContext);
	}

	async *streamChat(messages: GatewayChatMessage[], context: RuntimeContext = {}): AsyncGenerator<string> {
		const prompt = promptFromChatMessages(messages);
		const latestUserPrompt = latestUserPromptFromChatMessages(messages) || prompt;
		context = this.withTemporalContext(context, latestUserPrompt);
		if (isTitlePrompt(latestUserPrompt)) {
			if (!this.modelApiKey()) {
				for (const chunk of splitForStreaming(this.localChat(prompt))) yield chunk;
				return;
			}
			const title = await this.withTimeout(() => this.titleCompletion(prompt, context), context.signal);
			for (const chunk of splitForStreaming(title)) yield chunk;
			return;
		}
		if (isSimpleGreeting(latestUserPrompt)) {
			for (const chunk of splitForStreaming('Hi. What should NewsCraft work on?')) yield chunk;
			return;
		}
		const contextualClarification = contextualClarificationAnswer(messages, latestUserPrompt);
		if (contextualClarification) {
			for (const chunk of splitForStreaming(contextualClarification)) yield chunk;
			return;
		}
		if (shouldAskForClarification(messages, latestUserPrompt, context.conversationContext) && !context.documents?.length) {
			for (const chunk of splitForStreaming(clarificationAnswer(latestUserPrompt))) yield chunk;
			return;
		}
		const formatFollowup = formatOnlyFollowupAnswer(messages);
		if (formatFollowup) {
			for (const chunk of splitForStreaming(formatFollowup)) yield chunk;
			return;
		}
		if (isDirectAnswerPrompt(latestUserPrompt, context.conversationContext) && !context.documents?.length) {
			const answer = await this.withTimeout(() => this.directChatCompletion(messages, context), context.signal);
			this.emitInheritedCitationRecords(context, answer);
			for (const chunk of splitForStreaming(answer)) yield chunk;
			return;
		}
		if (!this.modelApiKey()) {
			for (const chunk of splitForStreaming(this.localChat(prompt))) yield chunk;
			return;
		}
		yield* this.disciplinedStream(
			buildDisciplinedChatPrompt(
			messages,
			{ timeZone: context.newsroomContext?.timezone },
			context.newsroomContext,
			context.documents,
			context.conversationContext,
			context.temporalContext
		),
			latestUserPrompt,
			context
		);
	}

	async runMission(prompt: string, context: RuntimeContext): Promise<MissionRuntimeResult> {
		context = this.withTemporalContext(context, prompt);
		const assignment = this.triageEditorCommand(prompt, context);
		const role = assignment.role;
		const agent = new DisciplinedNewsroomAgent({
			config: {
				...this.agentConfig,
				default_tool_budget: this.defaultToolBudget()
			},
			registry: this.controls.registry,
			repository: context.repository,
			openAiApiKey: this.controls.openAiApiKey,
			perplexityApiKey: this.controls.perplexityApiKey,
			modelProvider: this.modelProvider(),
			modelApiKey: this.modelApiKey()
		});
		const result = await agent.run(prompt, {
			repository: context.repository,
			runId: context.runId,
			jobId: context.jobId,
			openAiApiKey: this.controls.openAiApiKey,
			perplexityApiKey: this.controls.perplexityApiKey,
			modelProvider: this.modelProvider(),
			modelApiKey: this.modelApiKey(),
			trigger: context.trigger,
			newsroomContext: context.newsroomContext,
			temporalContext: context.temporalContext,
			conversationContext: context.conversationContext,
			documents: context.documents,
			signal: context.signal,
			onPlanEvent: (event) => context.onProgress?.({ type: 'plan', planSource: event.source, steps: event.steps }),
			onToolEvent: (event) => {
				// Include stepId in the tool-call id so each plan step that uses
				// the same tool gets a distinct DB row (e.g. web-search fallback
				// after a failed source-monitor step).
				const id = event.stepId
					? `${context.runId || 'run'}_${event.stepId}`
					: `${context.runId || 'run'}_${event.tool}`;
				if (event.type === 'tool_started') {
					context.onProgress?.({ type: 'tool', id, name: event.tool, status: 'running', detail: event.detail });
				}
				if (event.type === 'tool_completed') {
					for (const item of event.evidence || []) {
						context.onProgress?.({ type: 'source', source: evidenceToFetchedSource(item), stepId: event.stepId });
					}
					context.onProgress?.({
						type: 'tool',
						id,
						name: event.tool,
						status: event.status === 'ok' ? 'ok' : 'failed',
						detail: event.detail,
						result: { evidenceCount: event.evidence?.length || 0 }
					});
				}
				if (event.type === 'tool_skipped') {
					context.onProgress?.({ type: 'tool', id, name: event.tool, status: 'failed', detail: event.detail });
				}
			}
		});
		reconcileDocumentAndWebEvidence(result, context.documents);
		const markdown = await this.synthesizeMissionOutput(prompt, result, context);
		// Emit the citation records for the text that is actually persisted and
		// shown to the producer. Synthesis may remap or remove invalid markers.
		this.emitCitationRecords(result.evidence, markdown, context);
		const sources = result.evidence.map(evidenceToFetchedSource);
		return { role, markdown, sources, evidence: result.evidence };
	}

	private localChat(prompt: string): string {
		const role = this.assignmentDesk.triage(prompt, { default_tool_budget: this.defaultToolBudget() }).role;
		const url = firstUrl(prompt);
		return [
			`NewsCraft ${roleLabel(role)} ready.`,
			url
				? `I can use ${url} as a source and keep provenance in the harness run log.`
				: 'I can scan, summarize, compare coverage, and prepare source-backed research updates.',
			`For live model-backed analysis, set ${this.modelProvider() === 'openai' ? 'OPENAI_API_KEY' : 'PERPLEXITY_API_KEY'} on the newsroom harness.`
		].join('\n\n');
	}

	private async disciplinedComplete(prompt: string, routingPrompt: string, context: RuntimeContext): Promise<string> {
		this.triageEditorCommand(routingPrompt, context);
		const result = await this.runDisciplinedAgent(prompt, routingPrompt, context);
		return result.final_answer.trim() || this.localChat(prompt);
	}

	private async directChatCompletion(messages: GatewayChatMessage[], context: RuntimeContext): Promise<string> {
		const latestUserPrompt = latestUserPromptFromChatMessages(messages);
		const citationLinks = directCitationLinksFromConversation(latestUserPrompt, context.conversationContext);
		if (citationLinks) return citationLinks;
		const ocvo = draftNewsroomOcvoFromConversation(latestUserPrompt, context.conversationContext);
		if (ocvo) return ocvo;
		const prompt = buildDirectChatPrompt(messages, context.conversationContext);
		if (!this.modelApiKey()) return this.localDirectChat(prompt);
		const decision = this.modelDecision('interactive_chat', context);
		this.emitModelPolicyEvent(decision, context);
		if (!decision.allowed || !decision.model) return this.localDirectChat(prompt);
		try {
			const text = await completeProviderText({
				provider: this.modelProvider(),
				apiKey: this.modelApiKey(),
				model: decision.model,
				instructions: DIRECT_CHAT_INSTRUCTIONS,
				input: prompt,
				reasoningEffort: decision.reasoningEffort,
				maxOutputTokens: 1200,
				disableSearch: true,
				signal: context.signal
			});
			this.emitModelPolicyEvent(decision, context, 'model.call.completed');
			return cleanVisibleChatOutput(text, latestUserPromptFromChatMessages(messages)) || this.localDirectChat(prompt);
		} catch {
			this.emitModelPolicyEvent(decision, context, 'model.call.failed');
			return this.localDirectChat(prompt);
		}
	}

	private localDirectChat(prompt: string): string {
		const normalized = prompt.toLowerCase();
		if (/\b(headline|hed)\b/.test(normalized)) {
			return 'NewsCraft can draft headlines directly. Send the story facts or paste the copy, and I will keep attribution and uncertainty clear.';
		}
		if (/\b(plan|outline|brainstorm|pitch)\b/.test(normalized)) {
			return [
				'Here is a useful starting structure:',
				'1. Define the audience and desired outcome.',
				'2. Separate known facts, assumptions, and open questions.',
				'3. Turn the strongest angle into a short outline with next reporting or production steps.'
			].join('\n');
		}
		return "I couldn't complete that writing request right now.";
	}

	private async runDisciplinedAgent(
		prompt: string,
		routingPrompt: string,
		context: RuntimeContext,
		onAnswerDelta?: (delta: string) => void
	): Promise<NewsroomAgentRunResult> {
		const agent = new DisciplinedNewsroomAgent({
			config: {
				...this.agentConfig,
				default_tool_budget: this.defaultToolBudget(),
				...(context.plannerEnabled === false ? { planner_enabled: false } : {})
			},
			registry: this.controls.registry,
			repository: context.repository,
			openAiApiKey: this.controls.openAiApiKey,
			perplexityApiKey: this.controls.perplexityApiKey,
			modelProvider: this.modelProvider(),
			modelApiKey: this.modelApiKey()
		});
		const result = await agent.run(prompt, {
			repository: context.repository,
			runId: context.runId,
			jobId: context.jobId,
			openAiApiKey: this.controls.openAiApiKey,
			perplexityApiKey: this.controls.perplexityApiKey,
			modelProvider: this.modelProvider(),
			modelApiKey: this.modelApiKey(),
			trigger: context.trigger,
			newsroomContext: context.newsroomContext,
			temporalContext: context.temporalContext,
			conversationContext: context.conversationContext,
			documents: context.documents,
			signal: context.signal,
			outputStyle: 'chat',
			routingPrompt,
			forcePlanner: context.plannerEnabled === true,
			onPlanEvent: (event) => context.onProgress?.({ type: 'plan', planSource: event.source, steps: event.steps }),
			onToolEvent: (event) => this.forwardDisciplinedProgress(event, context),
			onAnswerDelta: shouldBufferGroundedAnswer(routingPrompt, context.conversationContext)
				? undefined
				: onAnswerDelta
		});
		reconcileDocumentAndWebEvidence(result, context.documents);
		this.emitCitationRecords(result.evidence, result.final_answer, context);
		return result;
	}

	private emitCitationRecords(evidence: EvidenceObject[], answer: string, context: RuntimeContext): void {
		const markers = new Set(citationMarkersInText(answer));
		const citations = citationRecordsFromEvidence(evidence).filter((citation) =>
			markers.has(citation.citationNumber)
		);
		context.onProgress?.({ type: 'citations', citations });
	}

	private withTemporalContext(context: RuntimeContext, request = ''): RuntimeContext {
		if (context.temporalContext) return context;
		return {
			...context,
			temporalContext: createNewsroomTemporalContext({
				now: (this.controls.clock || (() => new Date()))(),
				timeZone: context.newsroomContext?.timezone,
				request
			})
		};
	}

	private emitInheritedCitationRecords(context: RuntimeContext, answer: string): void {
		const citations = context.conversationContext?.lastSourceBackedAnswer?.citations ?? [];
		const markers = new Set(citationMarkersInText(answer));
		const referenced = citations.filter(
			(citation) => markers.has(citation.citationNumber) || answer.includes(citation.url)
		);
		if (referenced.length) context.onProgress?.({ type: 'citations', citations: referenced });
	}

	private async titleCompletion(prompt: string, context: RuntimeContext): Promise<string> {
		const decision = this.requireModel('title', context);
		try {
			const text = await completeProviderText({
				provider: this.modelProvider(),
				apiKey: this.modelApiKey(),
				model: decision.model,
				input: prompt,
				reasoningEffort: decision.reasoningEffort,
				disableSearch: true,
				signal: context.signal
			});
			this.emitModelPolicyEvent(decision, context, 'model.call.completed');
			return cleanVisibleChatOutput(text, prompt) || this.localChat(prompt);
		} catch (err) {
			this.emitModelPolicyEvent(decision, context, 'model.call.failed');
			throw err;
		}
	}

	/**
	 * Streamed variant of disciplinedComplete: answer-text deltas from the
	 * answer-producing tool are sanitized incrementally and yielded live, then
	 * reconciled against the authoritative final answer (which carries notes
	 * and caveats the live stream has not seen).
	 */
	private async *disciplinedStream(
		prompt: string,
		routingPrompt: string,
		context: RuntimeContext
	): AsyncGenerator<string> {
		this.triageEditorCommand(routingPrompt, context);
		const sanitizer = new StreamingAnswerSanitizer({ clean: (raw) => cleanVisibleChatOutput(raw, prompt) });
		const currentAsOf = currentAsOfPrefix(routingPrompt, context.newsroomContext?.timezone, context.temporalContext);
		const bufferAuthoritativeAnswer = shouldBufferGroundedAnswer(
			routingPrompt,
			context.conversationContext
		);
		let currentAsOfEmitted = false;
		const pending: string[] = [];
		let wake: (() => void) | null = null;
		const notify = () => {
			wake?.();
			wake = null;
		};
		let settled: { result: NewsroomAgentRunResult } | { error: unknown } | null = null;
		const runPromise = (async () => {
			try {
				const result = await this.withTimeout(
					() =>
						this.runDisciplinedAgent(prompt, routingPrompt, context, (delta) => {
							const addition = sanitizer.push(delta);
							if (addition) {
								pending.push(addition);
								notify();
							}
						}),
					context.signal
				);
				settled = { result };
			} catch (error) {
				settled = { error };
			} finally {
				notify();
			}
		})();

		if (bufferAuthoritativeAnswer && currentAsOf) {
			currentAsOfEmitted = true;
			yield `${currentAsOf}\n\n`;
		}

		while (!settled || pending.length) {
			if (pending.length) {
				if (currentAsOf && !currentAsOfEmitted) {
					currentAsOfEmitted = true;
					if (!/\bCurrent as of\b/i.test(sanitizer.emitted)) {
						yield `${currentAsOf}\n\n`;
						continue;
					}
				}
				yield pending.shift() as string;
				continue;
			}
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
		await runPromise;

		const outcome = settled as { result: NewsroomAgentRunResult } | { error: unknown };
		if ('error' in outcome) {
			if (!sanitizer.emitted) {
				if (currentAsOfEmitted) {
					yield 'Live research could not finish right now.';
					return;
				}
				throw outcome.error;
			}
			yield '\n\nThe research run was interrupted before it finished; treat the answer above as incomplete.';
			return;
		}
		const finalAnswer = outcome.result.final_answer.trim() || this.localChat(prompt);
		const visibleFinalAnswer = currentAsOfEmitted
			? withoutLeadingCurrentAsOf(finalAnswer)
			: finalAnswer;
		if (!sanitizer.emitted) {
			if (currentAsOf && !currentAsOfEmitted && !/\bCurrent as of\b/i.test(visibleFinalAnswer)) {
				yield `${currentAsOf}\n\n`;
			}
			for (const chunk of splitForStreaming(visibleFinalAnswer)) yield chunk;
			return;
		}
		const tail = streamTailForFinalAnswer(sanitizer.emitted, visibleFinalAnswer);
		if (tail === null) {
			// The final answer does not extend the streamed text (interrupted tool
			// stream or a whole-text rewrite). Emit it after a hard break rather
			// than silently dropping caveats or replacement content.
			for (const chunk of splitForStreaming(`\n\n${visibleFinalAnswer}`)) yield chunk;
			return;
		}
		for (const chunk of splitForStreaming(tail)) yield chunk;
	}

	private forwardDisciplinedProgress(event: AgentToolEvent, context: RuntimeContext): void {
		const id = `${context.runId || 'chat'}_${event.tool}`;
		if (event.type === 'tool_started') {
			context.onProgress?.({
				type: 'tool',
				id,
				name: event.tool,
				status: 'running',
				detail: event.detail || progressDetailForTool(event.tool)
			});
			return;
		}
		if (event.type === 'tool_completed') {
			for (const item of event.evidence || []) {
				context.onProgress?.({ type: 'source', source: evidenceToFetchedSource(item), stepId: event.stepId });
			}
			context.onProgress?.({
				type: 'tool',
				id,
				name: event.tool,
				status: event.status === 'ok' ? 'ok' : 'failed',
				detail: event.detail,
				result: {
					count: event.evidence?.length || 0,
					...(event.diagnostics ? { research: event.diagnostics } : {})
				}
			});
			return;
		}
		if (event.type === 'tool_skipped') {
			context.onProgress?.({ type: 'tool', id, name: event.tool, status: 'failed', detail: event.detail });
		}
	}

	private async synthesizeMissionOutput(
		prompt: string,
		result: NewsroomAgentRunResult,
		context: RuntimeContext
	): Promise<string> {
		if (!this.modelApiKey()) return result.final_answer;
		const task = context.trigger === 'schedule' ? 'scheduled_research_update' : 'manual_research_update';
		const decision = this.modelDecision(task, context);
		this.emitModelPolicyEvent(decision, context);
		if (!decision.allowed || !decision.model) return result.final_answer;
		try {
			const text = await completeProviderText({
				provider: this.modelProvider(),
				apiKey: this.modelApiKey(),
				model: decision.model,
				instructions: [
					NEWSROOM_CHARTER,
					formatNewsroomTemporalContext(context.temporalContext || createNewsroomTemporalContext({ request: prompt })),
					'You write the final output for a NewsCraft research update.',
					'The prompt is the output contract. Follow it exactly.',
					'Use the normalized evidence ledger below as the only factual basis. Synthesize once across all research passes; never concatenate provider mini-answers or repeat the same story in separate blocks.',
					'Keep citation markers attached to the claims they support. Do not invent citation numbers or cite a source that does not support the claim.',
					'Do not add default NewsCraft sections, internal process notes, or boilerplate unless the prompt asks for them.',
					'Use only the provided evidence. If the evidence is insufficient, say so in the requested format or as plainly as possible.',
					'For current-events and claim-verification requests, include an honest caveat when no reliable readable source confirms the claim, or when only weak/secondary evidence is available.',
					'Flag paywalled, blocked, CAPTCHA-protected, empty, unavailable, or unreadable sources in plain public language without exposing status codes or implementation details.',
					'If the current user request is an ambiguous follow-up and the provided context does not identify the referent, ask one brief clarifying question instead of guessing.',
					'Never invent publication dates. If a source says Published: NOT FOUND, write Date: Not found or omit the date; never use the accessed/run time as the publication date.',
					'Return only the research update.'
				].join('\n'),
				input: missionSynthesisInput(prompt, result, context.temporalContext),
				reasoningEffort: decision.reasoningEffort,
				disableSearch: true,
				signal: context.signal
			});
			this.emitModelPolicyEvent(decision, context, 'model.call.completed');
			const synthesized = text.trim();
			if (!synthesized) return result.final_answer;
			return enforceFinalCitationIntegrity(synthesized, result.evidence) || result.final_answer;
		} catch {
			this.emitModelPolicyEvent(decision, context, 'model.call.failed');
			return result.final_answer;
		}
	}

	private triageEditorCommand(prompt: string, context: RuntimeContext): AssignmentDeskDecision {
		const assignment = this.assignmentDesk.triage(prompt, { default_tool_budget: this.defaultToolBudget() });
		this.emitAssignmentDeskDecision(assignment, context);
		return assignment;
	}

	private requireModel(task: ModelPolicyTask, context: RuntimeContext): ModelPolicyDecision & { allowed: true; model: string } {
		const decision = this.modelDecision(task, context);
		this.emitModelPolicyEvent(decision, context);
		if (!decision.allowed || !decision.model) throw new Error(decision.reason);
		return { ...decision, allowed: true, model: decision.model };
	}

	private modelDecision(task: ModelPolicyTask, context: RuntimeContext): ModelPolicyDecision {
		return resolveModelPolicy(this.agentConfig.model_policy, task, {
			trigger: context.trigger,
			requestedModel: context.model
		});
	}

	private emitModelPolicyEvent(
		decision: ModelPolicyDecision,
		context: RuntimeContext,
		kind = decision.allowed ? 'model.call.selected' : 'model.call.skipped'
	): void {
		context.repository?.appendEvent({
			jobId: context.jobId,
			runId: context.runId,
			agent: 'model_policy',
			kind,
			payload: {
				task: decision.task,
				tier: decision.tier,
				model: decision.model,
				reason: decision.reason,
				trigger: decision.trigger
			},
			costMetadata: decision.model
				? {
						provider: this.modelProvider(),
						model: decision.model,
						task: decision.task,
						estimated: false
					}
				: null
		});
	}

	private emitAssignmentDeskDecision(assignment: AssignmentDeskDecision, context: RuntimeContext): void {
		const id = `${context.runId || 'chat'}_assignment_desk`;
		context.onProgress?.({
			type: 'tool',
			id,
			name: 'assignment_desk',
			status: 'running',
			detail: 'Routing request'
		});
		context.repository?.appendEvent({
			jobId: context.jobId,
			runId: context.runId,
			agent: assignment.event.agent,
			kind: assignment.event.kind,
			payload: assignment.event.payload
		});
		context.onProgress?.({
			type: 'tool',
			id,
			name: 'assignment_desk',
			status: 'ok',
			detail: 'Request routed',
			result: {
				role: assignment.role,
				selectedMode: assignment.route.selected_mode,
				tools: assignment.route.tools_to_use
			}
		});
	}

	private defaultToolBudget() {
		return {
			max_total_tool_calls: this.controls.maxToolCalls,
			max_custom_tool_calls: Math.min(4, this.controls.maxToolCalls),
			max_web_searches: 3,
			max_browser_tasks: 2,
			max_runtime_seconds: Math.ceil(this.controls.runTimeoutMs / 1000)
		};
	}

	private modelProvider(): ModelProvider {
		if (!this.controls.modelProvider && !this.controls.modelApiKey && this.controls.openAiApiKey) return 'openai';
		return this.controls.modelProvider || 'perplexity';
	}

	private modelApiKey(): string {
		return this.controls.modelApiKey || (this.modelProvider() === 'openai' ? this.controls.openAiApiKey : '');
	}

	private async withTimeout<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) throw new Error('run aborted');
		const timeout = AbortSignal.timeout(this.controls.runTimeoutMs);
		const abortPromise = new Promise<never>((_, reject) => {
			const onAbort = () => reject(new Error('run aborted'));
			signal?.addEventListener('abort', onAbort, { once: true });
			timeout.addEventListener('abort', () => reject(new Error('run timed out')), { once: true });
		});
		return Promise.race([fn(), abortPromise]);
	}

	private async withToolTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		const timeoutMs = Math.min(15_000, Math.max(1000, this.controls.runTimeoutMs - 1000));
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const combined =
			signal && typeof AbortSignal.any === 'function'
				? AbortSignal.any([signal, timeoutSignal])
				: timeoutSignal;
		return this.withTimeout(() => fn(combined), signal);
	}
}

function currentAsOfPrefix(prompt: string, timeZone?: string, temporalContext?: NewsroomTemporalContext): string {
	if (!isCurrentEventQuery(prompt)) return '';
	return `**Current as of:** ${currentAsOfLabel({ timeZone, now: temporalContext ? new Date(temporalContext.requestTimestamp) : undefined })}`;
}

function withCurrentAsOfLabel(answer: string, prompt: string, timeZone?: string, temporalContext?: NewsroomTemporalContext): string {
	if (!isCurrentEventQuery(prompt) || /\bCurrent as of\b/i.test(answer)) return answer;
	return `${currentAsOfPrefix(prompt, timeZone, temporalContext)}\n\n${answer}`;
}

function evidenceToFetchedSource(evidence: EvidenceObject): FetchedSource {
	const contentText = evidence.extracted_text || evidence.summary || evidence.title;
	return {
		url: evidence.source_url,
		title: evidence.title,
		fetchedAt: evidence.accessed_at,
		snippet: contentText.slice(0, 600),
		summary: evidence.summary,
		contentText,
		contentHash: createHash('sha256').update(`${evidence.source_url}\n${contentText}`).digest('hex'),
		contentType: evidence.source_url.startsWith('newsroom://') ? 'text/markdown' : null,
		statusCode: evidence.confidence > 0 ? 200 : null,
		used: evidence.confidence > 0,
		metadata: evidence.published_at ? { publishedAt: evidence.published_at } : null
	};
}

function isSimpleGreeting(prompt: string): boolean {
	return /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|howdy|hiya)[!.? ]*$/i.test(
		prompt.trim()
	);
}

function isDirectAnswerPrompt(prompt: string, conversationContext?: ConversationContext): boolean {
	if (conversationContext?.currentTurn?.researchRequired) return false;
	if (conversationContext?.intent === 'transform' && conversationContext.lastSourceBackedAnswer) return true;
	if (/\b(?:turn|rewrite|using only)\b[\s\S]{0,100}\bprevious answer\b/i.test(prompt)) return true;
	if (
		conversationContext?.lastSourceBackedAnswer &&
		(
			/\b(?:using|use)\s+only\b[\s\S]{0,120}\b(?:inherited|provided|previous|existing)\b[\s\S]{0,80}\b(?:evidence|answer|citations?)\b/i.test(
				prompt
			) ||
			/\bdo not (?:re-?search|search)\b/i.test(prompt)
		)
	) {
		return true;
	}
	return routeNewsroomRequest(prompt).selected_mode === 'direct_answer';
}

function shouldAskForClarification(
	messages: GatewayChatMessage[],
	latestUserPrompt: string,
	conversationContext?: ConversationContext
): boolean {
	if (routeNewsroomRequest(latestUserPrompt).selected_mode !== 'clarification_needed') return false;
	if (conversationContext?.activeTopic || conversationContext?.lastSourceBackedAnswer) return false;
	const latestUserIndex = latestUserIndexFromChatMessages(messages);
	return !recentConversationContext(messages, latestUserIndex);
}

function contextualClarificationAnswer(
	messages: GatewayChatMessage[],
	latestUserPrompt: string
): string | null {
	const referentialStatementFollowup =
		/\bwhat did (?:the )?(?:police|official|agency|department)?\s*statement (?:actually )?say\b/i.test(
			latestUserPrompt
		);
	if (
		routeNewsroomRequest(latestUserPrompt).selected_mode !== 'clarification_needed' &&
		!referentialStatementFollowup
	) {
		return null;
	}
	const latestUserIndex = latestUserIndexFromChatMessages(messages);
	if (latestUserIndex < 1) return null;
	for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== 'user') continue;
		const priorContext = chatMessageText(message).replace(/\s+/g, ' ').trim();
		if (!priorContext) continue;
		const compactContext =
			priorContext.length <= 420 ? priorContext : `${priorContext.slice(0, 419).trim()}…`;
		return `From the context already in this thread: ${compactContext}\n\nThe original source wording is not included here, so I can't quote or verify anything beyond that context.`;
	}
	return null;
}

function clarificationAnswer(prompt: string): string {
	if (/\b(?:they|he|she|it|that|this)\b/i.test(prompt)) {
		return 'Could you clarify what story, source, or statement you mean? I need that context before I can answer cleanly.';
	}
	return 'Could you clarify the story, source, or newsroom task you want me to work on?';
}

function missionSynthesisInput(
	prompt: string,
	result: NewsroomAgentRunResult,
	temporalContext?: NewsroomTemporalContext
): string {
	const evidence = result.evidence.length
		? result.evidence
				.map((item, index) =>
					[
						`Evidence ${item.evidence_id || `ev_${index + 1}`} (citation ${item.citation_number || index + 1}): ${item.title}`,
						`URL: ${item.source_url}`,
						`Page role: ${item.page_role || 'unknown'}; temporal scope: ${item.temporal_scope || 'unspecified'}`,
						item.published_at
							? `Published: ${item.published_at}`
							: 'Published: NOT FOUND IN SOURCE METADATA. Do not infer this from the accessed/run time.',
						item.event_at ? `Event time: ${item.event_at}` : '',
						`Accessed: ${item.accessed_at} (retrieval time only; not a publication date)`,
						`Supporting excerpt: ${truncateEvidence(item.supporting_excerpt || item.extracted_text || item.summary || item.title)}`,
						item.limitations.length ? `Limitations: ${item.limitations.join('; ')}` : ''
					]
						.filter(Boolean)
						.join('\n')
				)
				.join('\n\n')
		: 'No usable evidence was gathered.';
	const limitations = result.limitations.length ? result.limitations.join('\n') : 'None recorded.';
	return `${temporalContext ? `${formatNewsroomTemporalContext(temporalContext)}\n\n` : ''}Research prompt:
${prompt}

Evidence gathered for this run:
${evidence}

Limitations:
${limitations}

Write the research update now. Follow the prompt's requested output format exactly.`;
}

function truncateEvidence(value: string, maxLength = 1800): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, maxLength - 1).trim()}…`;
}

function latestUserPromptFromChatMessages(messages: GatewayChatMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== 'user') continue;
		const text =
			typeof message.content === 'string'
				? message.content
				: message.content
						.filter((part) => part.type === 'text')
						.map((part) => part.text)
						.join('\n');
		if (text.trim()) return text.trim();
	}
	return '';
}

function formatOnlyFollowupAnswer(messages: GatewayChatMessage[]): string | null {
	const latestUserIndex = latestUserIndexFromChatMessages(messages);
	if (latestUserIndex < 0) return null;
	const latestUserPrompt = chatMessageText(messages[latestUserIndex]).trim();
	if (!isTableFormatFollowup(latestUserPrompt)) return null;
	const prior = priorAssistantText(messages, latestUserIndex);
	if (!prior) return null;
	const table = fixtureTableFromPriorAnswer(prior) || existingMarkdownTable(prior) || bulletTableFromPriorAnswer(prior);
	if (!table) return null;
	return cleanVisibleChatOutput(table, latestUserPrompt);
}

function isTableFormatFollowup(prompt: string): boolean {
	const normalized = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
	if (!/\b(table|tabular|rows?|columns?)\b/.test(normalized)) return false;
	return /\b(give|show|display|format|put|turn|make|convert|present)\b/.test(normalized);
}

function priorAssistantText(messages: GatewayChatMessage[], beforeIndex: number): string {
	for (let index = beforeIndex - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== 'assistant') continue;
		const text = chatMessageText(message).trim();
		if (text) return text;
	}
	return '';
}

function existingMarkdownTable(value: string): string {
	const lines = value.split('\n').map((line) => line.trim());
	for (let index = 0; index < lines.length - 1; index += 1) {
		if (!isMarkdownTableRow(lines[index]) || !/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1])) {
			continue;
		}
		const table = [lines[index], lines[index + 1]];
		for (let row = index + 2; row < lines.length; row += 1) {
			if (!isMarkdownTableRow(lines[row])) break;
			table.push(lines[row]);
		}
		return table.join('\n');
	}
	return '';
}

function isMarkdownTableRow(value: string): boolean {
	return value.includes('|') && value.split('|').filter((cell) => cell.trim()).length >= 2;
}

interface FixtureRow {
	group: string;
	match: string;
	kickoff: string;
	venue: string;
}

function fixtureTableFromPriorAnswer(value: string): string {
	const rows: FixtureRow[] = [];
	let current: FixtureRow | null = null;
	for (const rawLine of value.split('\n')) {
		const line = rawLine.trim().replace(/^[-*]\s*/, '').trim();
		if (!line) continue;
		const match = line.match(/^(Group\s+[A-Z0-9]+)\s+[-–—]\s+(.+)$/i);
		if (match) {
			current = { group: match[1], match: match[2].trim(), kickoff: '', venue: '' };
			rows.push(current);
			continue;
		}
		if (!current) continue;
		const kickoff = line.match(/^Kick[- ]?off:\s*(.+)$/i);
		if (kickoff) {
			current.kickoff = kickoff[1].trim();
			continue;
		}
		const venue = line.match(/^Venue:\s*(.+)$/i);
		if (venue) current.venue = venue[1].trim();
	}
	if (!rows.length) return '';
	return [
		'| Group | Match | Kick-off | Venue |',
		'|---|---|---|---|',
		...rows.map((row) =>
			`| ${tableCell(row.group)} | ${tableCell(row.match)} | ${tableCell(row.kickoff || 'Not specified')} | ${tableCell(row.venue || 'Not specified')} |`
		)
	].join('\n');
}

function bulletTableFromPriorAnswer(value: string): string {
	const rows = value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => /^[-*]\s+/.test(line))
		.map((line) => line.replace(/^[-*]\s+/, '').trim())
		.filter(Boolean)
		.slice(0, 20);
	if (!rows.length) return '';
	return ['| Item | Details |', '|---|---|', ...rows.map((row, index) => `| ${index + 1} | ${tableCell(row)} |`)].join('\n');
}

function tableCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

export function buildDisciplinedChatPrompt(
	messages: GatewayChatMessage[],
	timeOptions: NewsroomTimeContextOptions = {},
	newsroomContext?: NewsroomContext,
	documents: DocumentContext[] = [],
	conversationContext?: ConversationContext,
	temporalContext?: NewsroomTemporalContext
): string {
	const latestUserIndex = latestUserIndexFromChatMessages(messages);
	const latestUserPrompt =
		latestUserIndex >= 0 ? chatMessageText(messages[latestUserIndex]).trim() : promptFromChatMessages(messages).trim();
	if (!latestUserPrompt) return promptFromChatMessages(messages);

	const groundedContext = formatConversationContext(conversationContext);
	const priorContext = recentConversationContext(messages, latestUserIndex);
	const systemInstructions = systemInstructionsFromChatMessages(messages);
	const dateContext = temporalContext
		? formatNewsroomTemporalContext(temporalContext)
		: newsroomTimeContext(timeOptions);
	const structuredContext = structuredNewsroomContext(newsroomContext);
	const documentContext = structuredDocumentContext(documents);
	if (!priorContext) {
		return [
			NEWSROOM_CHARTER,
			'',
			dateContext,
			...(structuredContext ? ['', structuredContext] : []),
			...(documentContext ? ['', documentContext] : []),
			...(groundedContext ? ['', groundedContext] : []),
			...(systemInstructions ? ['', 'System and newsroom instructions:', systemInstructions] : []),
			'',
			'Current user question:',
			latestUserPrompt
		].join('\n');
	}

	return [
		NEWSROOM_CHARTER,
		'',
		dateContext,
		...(structuredContext ? ['', structuredContext] : []),
		...(documentContext ? ['', documentContext] : []),
		...(groundedContext ? ['', groundedContext] : []),
		...(systemInstructions ? ['', 'System and newsroom instructions:', systemInstructions] : []),
		'',
		'Current user question:',
		latestUserPrompt,
		'',
		'Recent conversation context for resolving follow-up references:',
		priorContext,
		'',
		'Use the recent context to resolve pronouns, article references, and source references. Answer the current user question, and do not treat prior assistant wording as fresh evidence unless source details are included.'
	].join('\n');
}

function structuredNewsroomContext(context: NewsroomContext | undefined): string {
	if (!context) return '';
	return [
		'Newsroom profile:',
		`- Timezone: ${context.timezone}`,
		...(context.homeMarket ? [`- Home market: ${context.homeMarket}`] : []),
		...(context.preferredDomains?.length
			? [`- Preferred source domains: ${context.preferredDomains.join(', ')}`]
			: [])
	].join('\n');
}

function structuredDocumentContext(documents: DocumentContext[]): string {
	if (!documents.length) return '';
	return [
		'Private conversation documents:',
		'Use these documents as user-provided evidence. Do not search externally unless the user explicitly asks to verify or corroborate them.',
		...documents.flatMap((document) => [
			`Document: ${document.filename} (${document.pageCount} pages)`,
			...document.pages.map((page) => `Page ${page.pageNumber}:\n${page.text}`)
		])
	].join('\n\n');
}

function citationRecordsFromEvidence(evidence: EvidenceObject[]): CitationRecord[] {
	const withMetadata = evidence.map((item, index) => {
		const extended = item as EvidenceObject & { citation_number?: number; document_page?: number };
		return {
			item,
			index,
			citationNumber:
				Number.isInteger(extended.citation_number) && Number(extended.citation_number) > 0
					? Number(extended.citation_number)
					: null,
			documentPage:
				Number.isInteger(extended.document_page) && Number(extended.document_page) > 0
					? Number(extended.document_page)
					: undefined
		};
	});
	const hasExplicitNumbers = withMetadata.some((entry) => entry.citationNumber != null);
	const records = new Map<number, CitationRecord>();
	for (const entry of withMetadata) {
		if (hasExplicitNumbers && entry.citationNumber == null) continue;
		const citationNumber = entry.citationNumber ?? entry.index + 1;
		if (records.has(citationNumber)) continue;
		const sourceType = citationSourceType(entry.item.source_kind);
		const url = entry.item.source_url;
		if (!/^https?:\/\//i.test(url) && !url.startsWith('/api/')) continue;
		records.set(citationNumber, {
			citationNumber,
			title: entry.item.title || entry.item.source_name || url,
			url,
			domain: citationDomain(url, sourceType),
			publicationDate: entry.item.published_at || null,
			sourceType,
			supportingExcerpt: truncateEvidence(
				entry.item.summary || entry.item.extracted_text || entry.item.title,
				900
			),
			...(entry.documentPage ? { documentPage: entry.documentPage } : {})
		});
	}
	return Array.from(records.values()).sort((a, b) => a.citationNumber - b.citationNumber);
}

function reconcileDocumentAndWebEvidence(
	result: NewsroomAgentRunResult,
	documents: DocumentContext[] | undefined
): void {
	if (!documents?.length) return;
	const webEvidence = result.evidence.filter(
		(item) => item.tool_used === 'openai_web_search' && item.citation_number
	);
	const documentEvidence = result.evidence.filter((item) => item.source_kind === 'user_document');
	if (!webEvidence.length || !documentEvidence.length) return;
	for (const [index, item] of webEvidence.entries()) item.citation_number = index + 1;
	for (const [index, item] of documentEvidence.entries()) {
		item.citation_number = webEvidence.length + index + 1;
	}
	const documentNotes = documentEvidence.slice(0, 3).map((item) => {
		const excerpt = truncateEvidence(item.summary || item.extracted_text || item.title, 360);
		return `- ${excerpt} [${item.citation_number}]`;
	});
	if (documentNotes.length) {
		result.final_answer = `${result.final_answer.trim()}\n\n**Attached document evidence**\n\n${documentNotes.join('\n')}`;
	}
}

function citationSourceType(value: EvidenceObject['source_kind']): CitationSourceType {
	if (value === 'official') return 'official';
	if (value === 'primary') return 'primary';
	if (value === 'media_report' || value === 'news_report') return 'news_report';
	if (value === 'social_post') return 'social_post';
	if (value === 'user_document') return 'user_document';
	if (value === 'commercial') return 'commercial';
	return 'unknown';
}

function citationDomain(url: string, sourceType: CitationSourceType): string {
	if (sourceType === 'user_document' || url.startsWith('/api/')) return 'Attached document';
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return 'Unknown source';
	}
}

function citationMarkersInText(value: string): number[] {
	return Array.from(value.matchAll(/\[(\d+)\]/g), (match) => Number(match[1])).filter((number) =>
		Number.isInteger(number)
	);
}

function buildDirectChatPrompt(messages: GatewayChatMessage[], conversationContext?: ConversationContext): string {
	const latestUserIndex = latestUserIndexFromChatMessages(messages);
	const latestUserPrompt =
		latestUserIndex >= 0 ? chatMessageText(messages[latestUserIndex]).trim() : promptFromChatMessages(messages).trim();
	if (!latestUserPrompt) return promptFromChatMessages(messages);

	const groundedContext = formatConversationContext(conversationContext);
	const priorContext = recentConversationContext(messages, latestUserIndex);
	const systemInstructions = systemInstructionsFromChatMessages(messages);
	return [
		NEWSROOM_CHARTER,
		'',
		...(systemInstructions ? ['System and newsroom instructions:', systemInstructions, ''] : []),
		...(groundedContext ? [groundedContext, ''] : []),
		'Current user request:',
		latestUserPrompt,
		...(priorContext ? ['', 'Recent conversation context:', priorContext] : [])
	].join('\n');
}

function shouldBufferGroundedAnswer(
	prompt: string,
	conversationContext?: ConversationContext
): boolean {
	if (
		isCurrentEventQuery(prompt) ||
		/\b(?:verify|fact[- ]?check|confirm)\b/i.test(prompt)
	) {
		return true;
	}
	if (!conversationContext) return false;
	if (conversationContext.currentTurn?.researchRequired) return true;
	if (conversationContext.claimStates?.length) return true;
	const topic = conversationContext.activeTopic;
	if (!topic) return false;
	// Buffer only when the conversation guard may reject streamed provider text
	// after checking evidence against topic constraints.
	return Boolean(
		topic.location ||
			topic.relevantDate ||
			topic.entities?.length ||
			topic.requestedOutlets?.length ||
			topic.directSourcesRequired
	);
}

function withoutLeadingCurrentAsOf(value: string): string {
	return value
		.replace(/^\s*\*\*Current as of:\*\*[^\n]*(?:\n+|$)/i, '')
		.replace(/^\s*Current as of:[^\n]*(?:\n+|$)/i, '')
		.trimStart();
}

function latestUserIndexFromChatMessages(messages: GatewayChatMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === 'user' && chatMessageText(messages[index]).trim()) return index;
	}
	return -1;
}

function recentConversationContext(messages: GatewayChatMessage[], latestUserIndex: number): string {
	if (latestUserIndex <= 0) return '';
	const prior = messages
		.slice(0, latestUserIndex)
		.filter((message) => message.role === 'user' || message.role === 'assistant')
		.slice(-MAX_FOLLOWUP_CONTEXT_MESSAGES)
		.map((message) => {
			const text = compactChatContextText(chatMessageText(message), MAX_FOLLOWUP_MESSAGE_CHARS);
			if (!text) return '';
			return `${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
		})
		.filter(Boolean)
		.join('\n\n');
	return compactChatContextText(prior, MAX_FOLLOWUP_CONTEXT_CHARS);
}

function systemInstructionsFromChatMessages(messages: GatewayChatMessage[]): string {
	const instructions = messages
		.filter((message) => message.role === 'system')
		.map((message) => compactChatContextText(chatMessageText(message), MAX_FOLLOWUP_MESSAGE_CHARS))
		.filter(Boolean)
		.join('\n\n');
	return compactChatContextText(instructions, MAX_FOLLOWUP_CONTEXT_CHARS);
}

function chatMessageText(message: GatewayChatMessage): string {
	if (!message?.content) return '';
	if (typeof message.content === 'string') return message.content;
	return message.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
}

function compactChatContextText(value: string, maxLength: number): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	const keepStart = Math.ceil((maxLength - 5) * 0.6);
	const keepEnd = Math.floor((maxLength - 5) * 0.4);
	return `${cleaned.slice(0, keepStart).trim()} ... ${cleaned.slice(-keepEnd).trim()}`;
}

function progressDetailForTool(tool: string): string {
	if (tool === 'openai_web_search') return 'Searching current coverage';
	if (tool === 'configured_source_monitor') return 'Checking configured sources';
	if (tool === 'source_feed_fetcher') return 'Reading attached source feeds';
	if (tool === 'saved_research_reader') return 'Reading saved NewsCraft research';
	return '';
}

function isTitlePrompt(prompt: string): boolean {
	return /^title for this conversation:?\s*$/i.test(prompt.trim());
}
