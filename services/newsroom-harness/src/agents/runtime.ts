import type { GatewayChatMessage, ReasoningEffort } from '@newscraft/shared';
import { createHash } from 'node:crypto';
import { AssignmentDesk, type AssignmentDeskDecision } from './assignment-desk.js';
import { cleanVisibleChatOutput } from './answer.js';
import { roleLabel, type NewsroomRole } from './roles.js';
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
import { completeOpenAiText } from '../util/openai-complete.js';
import { firstUrl, promptFromChatMessages, splitForStreaming } from '../util/text.js';
import type { HarnessRepository } from '../db/repository.js';

export interface RuntimeControls {
	maxToolCalls: number;
	runTimeoutMs: number;
	retryLimit: number;
	openAiApiKey: string;
	agentConfig?: Partial<NewsroomAgentConfig>;
	/** Tool registry override, mainly for tests. */
	registry?: ToolRegistry;
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
}

export type RuntimeProgressEvent =
	| { type: 'tool'; id: string; name: string; status: string; detail?: string; result?: unknown }
	| { type: 'source'; source: FetchedSource; stepId?: string }
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

export class NewsroomAgentRuntime {
	private readonly assignmentDesk = new AssignmentDesk();
	private readonly agentConfig: NewsroomAgentConfig;

	constructor(private controls: RuntimeControls) {
		this.agentConfig = createNewsroomAgentConfig(controls.agentConfig);
	}

	async completeChat(messages: GatewayChatMessage[], context: RuntimeContext = {}): Promise<string> {
		const prompt = promptFromChatMessages(messages);
		const latestUserPrompt = latestUserPromptFromChatMessages(messages) || prompt;
		if (!this.controls.openAiApiKey) return this.localChat(prompt);
		if (isTitlePrompt(latestUserPrompt)) {
			return this.withTimeout(() => this.titleCompletion(prompt, context), context.signal);
		}
		return this.withTimeout(
			() => this.disciplinedComplete(buildDisciplinedChatPrompt(messages), context),
			context.signal
		);
	}

	async *streamChat(messages: GatewayChatMessage[], context: RuntimeContext = {}): AsyncGenerator<string> {
		const prompt = promptFromChatMessages(messages);
		const latestUserPrompt = latestUserPromptFromChatMessages(messages) || prompt;
		if (!this.controls.openAiApiKey) {
			for (const chunk of splitForStreaming(this.localChat(prompt))) yield chunk;
			return;
		}
		if (isTitlePrompt(latestUserPrompt)) {
			const title = await this.withTimeout(() => this.titleCompletion(prompt, context), context.signal);
			for (const chunk of splitForStreaming(title)) yield chunk;
			return;
		}
		yield* this.disciplinedStream(buildDisciplinedChatPrompt(messages), context);
	}

	async runMission(prompt: string, context: RuntimeContext): Promise<MissionRuntimeResult> {
		const assignment = this.triageEditorCommand(prompt, context);
		const role = assignment.role;
		const agent = new DisciplinedNewsroomAgent({
			config: {
				...this.agentConfig,
				default_tool_budget: this.defaultToolBudget()
			},
			registry: this.controls.registry,
			repository: context.repository,
			openAiApiKey: this.controls.openAiApiKey
		});
		const result = await agent.run(prompt, {
			repository: context.repository,
			runId: context.runId,
			jobId: context.jobId,
			openAiApiKey: this.controls.openAiApiKey,
			trigger: context.trigger,
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
		const sources = result.evidence.map(evidenceToFetchedSource);
		const markdown = await this.synthesizeMissionOutput(prompt, result, context);
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
			'For live model-backed analysis, set OPENAI_API_KEY on the newsroom harness.'
		].join('\n\n');
	}

	private async disciplinedComplete(prompt: string, context: RuntimeContext): Promise<string> {
		this.triageEditorCommand(prompt, context);
		const result = await this.runDisciplinedAgent(prompt, context);
		return result.final_answer.trim() || this.localChat(prompt);
	}

	private async runDisciplinedAgent(
		prompt: string,
		context: RuntimeContext,
		onAnswerDelta?: (delta: string) => void
	): Promise<NewsroomAgentRunResult> {
		const agent = new DisciplinedNewsroomAgent({
			config: {
				...this.agentConfig,
				default_tool_budget: this.defaultToolBudget()
			},
			registry: this.controls.registry,
			repository: context.repository,
			openAiApiKey: this.controls.openAiApiKey
		});
		return agent.run(prompt, {
			repository: context.repository,
			runId: context.runId,
			jobId: context.jobId,
			openAiApiKey: this.controls.openAiApiKey,
			trigger: context.trigger,
			signal: context.signal,
			outputStyle: 'chat',
			onPlanEvent: (event) => context.onProgress?.({ type: 'plan', planSource: event.source, steps: event.steps }),
			onToolEvent: (event) => this.forwardDisciplinedProgress(event, context),
			onAnswerDelta
		});
	}

	private async titleCompletion(prompt: string, context: RuntimeContext): Promise<string> {
		const decision = this.requireModel('title', context);
		try {
			const text = await completeOpenAiText({
				apiKey: this.controls.openAiApiKey,
				model: decision.model,
				input: prompt,
				reasoningEffort: decision.reasoningEffort,
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
	private async *disciplinedStream(prompt: string, context: RuntimeContext): AsyncGenerator<string> {
		this.triageEditorCommand(prompt, context);
		const sanitizer = new StreamingAnswerSanitizer({ clean: (raw) => cleanVisibleChatOutput(raw, prompt) });
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
						this.runDisciplinedAgent(prompt, context, (delta) => {
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

		while (!settled || pending.length) {
			if (pending.length) {
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
			if (!sanitizer.emitted) throw outcome.error;
			yield '\n\nThe research run was interrupted before it finished; treat the answer above as incomplete.';
			return;
		}
		const finalAnswer = outcome.result.final_answer.trim() || this.localChat(prompt);
		if (!sanitizer.emitted) {
			for (const chunk of splitForStreaming(finalAnswer)) yield chunk;
			return;
		}
		const tail = streamTailForFinalAnswer(sanitizer.emitted, finalAnswer);
		if (tail === null) {
			// The final answer does not extend the streamed text (interrupted tool
			// stream or a whole-text rewrite). Emit it after a hard break rather
			// than silently dropping caveats or replacement content.
			for (const chunk of splitForStreaming(`\n\n${finalAnswer}`)) yield chunk;
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
				result: { count: event.evidence?.length || 0 }
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
		if (!this.controls.openAiApiKey) return result.final_answer;
		const task = context.trigger === 'schedule' ? 'scheduled_research_update' : 'manual_research_update';
		const decision = this.modelDecision(task, context);
		this.emitModelPolicyEvent(decision, context);
		if (!decision.allowed || !decision.model) return result.final_answer;
		try {
			const text = await completeOpenAiText({
				apiKey: this.controls.openAiApiKey,
				model: decision.model,
				instructions: [
					'You write the final output for a NewsCraft research update.',
					'The prompt is the output contract. Follow it exactly.',
					'Do not add default NewsCraft sections, internal process notes, or boilerplate unless the prompt asks for them.',
					'Use only the provided evidence. If the evidence is insufficient, say so in the requested format or as plainly as possible.',
					'Never invent publication dates. If a source says Published: NOT FOUND, write Date: Not found or omit the date; never use the accessed/run time as the publication date.',
					'Return only the research update.'
				].join('\n'),
				input: missionSynthesisInput(prompt, result),
				reasoningEffort: decision.reasoningEffort,
				signal: context.signal
			});
			this.emitModelPolicyEvent(decision, context, 'model.call.completed');
			return text.trim() || result.final_answer;
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
						provider: 'openai',
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

function missionSynthesisInput(prompt: string, result: NewsroomAgentRunResult): string {
	const evidence = result.evidence.length
		? result.evidence
				.slice(0, 20)
				.map((item, index) =>
					[
						`Source ${index + 1}: ${item.title}`,
						`URL: ${item.source_url}`,
						item.published_at
							? `Published: ${item.published_at}`
							: 'Published: NOT FOUND IN SOURCE METADATA. Do not infer this from the accessed/run time.',
						`Accessed: ${item.accessed_at} (retrieval time only; not a publication date)`,
						`Text: ${truncateEvidence(item.extracted_text || item.summary || item.title)}`
					]
						.filter(Boolean)
						.join('\n')
				)
				.join('\n\n')
		: 'No usable evidence was gathered.';
	const limitations = result.limitations.length ? result.limitations.join('\n') : 'None recorded.';
	return `Research prompt:
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

export function buildDisciplinedChatPrompt(messages: GatewayChatMessage[]): string {
	const latestUserIndex = latestUserIndexFromChatMessages(messages);
	const latestUserPrompt =
		latestUserIndex >= 0 ? chatMessageText(messages[latestUserIndex]).trim() : promptFromChatMessages(messages).trim();
	if (!latestUserPrompt) return promptFromChatMessages(messages);

	const priorContext = recentConversationContext(messages, latestUserIndex);
	if (!priorContext) return latestUserPrompt;

	return [
		'Current user question:',
		latestUserPrompt,
		'',
		'Recent conversation context for resolving follow-up references:',
		priorContext,
		'',
		'Use the recent context to resolve pronouns, article references, and source references. Answer the current user question, and do not treat prior assistant wording as fresh evidence unless source details are included.'
	].join('\n');
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
