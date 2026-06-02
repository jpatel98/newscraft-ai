import type { GatewayChatMessage, ReasoningEffort } from '@newscraft/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssignmentDesk, type AssignmentDeskDecision } from './assignment-desk.js';
import { cleanVisibleChatOutput } from './answer.js';
import { roleInstructionsFor, roleLabel, type NewsroomRole } from './roles.js';
import { DisciplinedNewsroomAgent, type AgentToolEvent, type NewsroomAgentRunResult } from './newsroom-agent.js';
import type { EvidenceObject } from './evidence.js';
import { createNewsroomAgentConfig, type NewsroomAgentConfig } from './harness-config.js';
import { resolveModelPolicy, type ModelPolicyDecision, type ModelPolicyTask } from './model-policy.js';
import { fetchSourceUrl, sourceFromText, type FetchedSource } from '../tools/sources.js';
import { firstUrl, promptFromChatMessages, splitForStreaming } from '../util/text.js';
import type { HarnessRepository } from '../db/repository.js';

export interface RuntimeControls {
	maxToolCalls: number;
	runTimeoutMs: number;
	retryLimit: number;
	openAiApiKey: string;
	agentConfig?: Partial<NewsroomAgentConfig>;
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
	| { type: 'source'; source: FetchedSource };

export interface MissionRuntimeResult {
	role: NewsroomRole;
	markdown: string;
	sources: FetchedSource[];
	evidence: EvidenceObject[];
}

const CHAT_VISIBLE_OUTPUT_INSTRUCTIONS = [
	'For web chat, write like a clean local-news brief, not an academic source report.',
	'Do not write Sources, References, citation lists, raw URLs, domain parentheticals, or posting-time roundups. Source tags are rendered separately in the UI.',
	'Do not use markdown markers such as #, **, markdown links, or markdown bullets.',
	'For multi-story answers, use plain text sections. Put section headings on their own line, then one story per line as "Counterfeit gear bust: One clean sentence." Do not pack several stories into one paragraph.',
	'Do not write the word "Bold".',
	'If the user asks for today, lead with today. Put older but relevant items under Latest context only when they are necessary.'
].join('\n');

function httpUrlToolParameter(description: string) {
	return z.string().min(1).describe(description);
}

export function urlFetchToolParameters() {
	return z.object({ url: httpUrlToolParameter('HTTP or HTTPS URL to fetch.') });
}

export function sourceSnapshotToolParameters() {
	return z.object({
		url: httpUrlToolParameter('HTTP or HTTPS source URL.'),
		title: z.string().optional(),
		text: z.string().min(1)
	});
}

export class NewsroomAgentRuntime {
	private readonly assignmentDesk = new AssignmentDesk();
	private readonly agentConfig: NewsroomAgentConfig;

	constructor(private controls: RuntimeControls) {
		this.agentConfig = createNewsroomAgentConfig(controls.agentConfig);
	}

	async completeChat(messages: GatewayChatMessage[], context: RuntimeContext = {}): Promise<string> {
		const prompt = promptFromChatMessages(messages);
		const taskPrompt = latestUserPromptFromChatMessages(messages) || prompt;
		if (!this.controls.openAiApiKey) return this.localChat(prompt);
		if (shouldUseDisciplinedChat(taskPrompt)) {
			return this.withTimeout(() => this.disciplinedComplete(taskPrompt, context), context.signal);
		}
		return this.withTimeout(() => this.sdkComplete(prompt, context), context.signal);
	}

	async *streamChat(messages: GatewayChatMessage[], context: RuntimeContext = {}): AsyncGenerator<string> {
		const prompt = promptFromChatMessages(messages);
		const taskPrompt = latestUserPromptFromChatMessages(messages) || prompt;
		if (!this.controls.openAiApiKey) {
			for (const chunk of splitForStreaming(this.localChat(prompt))) yield chunk;
			return;
		}
		if (shouldUseDisciplinedChat(taskPrompt)) {
			const text = await this.withTimeout(() => this.disciplinedComplete(taskPrompt, context), context.signal);
			for (const chunk of splitForStreaming(text)) yield chunk;
			return;
		}
		yield* this.sdkStream(prompt, context);
	}

	async runMission(prompt: string, context: RuntimeContext): Promise<MissionRuntimeResult> {
		const assignment = this.triageEditorCommand(prompt, context);
		const role = assignment.role;
		const agent = new DisciplinedNewsroomAgent({
			config: {
				...this.agentConfig,
				default_tool_budget: this.defaultToolBudget()
			},
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
			onToolEvent: (event) => {
				const id = `${context.runId || 'run'}_${event.tool}`;
				if (event.type === 'tool_started') {
					context.onProgress?.({ type: 'tool', id, name: event.tool, status: 'running', detail: event.detail });
				}
				if (event.type === 'tool_completed') {
					for (const item of event.evidence || []) context.onProgress?.({ type: 'source', source: evidenceToFetchedSource(item) });
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

	private async runDisciplinedAgent(prompt: string, context: RuntimeContext): Promise<NewsroomAgentRunResult> {
		const agent = new DisciplinedNewsroomAgent({
			config: {
				...this.agentConfig,
				default_tool_budget: this.defaultToolBudget()
			},
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
			onToolEvent: (event) => this.forwardDisciplinedProgress(event, context)
		});
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
			for (const item of event.evidence || []) context.onProgress?.({ type: 'source', source: evidenceToFetchedSource(item) });
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

	private async sdkComplete(prompt: string, context: RuntimeContext): Promise<string> {
		const sdk = await import('@openai/agents');
		sdk.setTracingDisabled(true);
		const agent = this.createSdkAgent(sdk, this.sdkRoleForPrompt(prompt, context), context);
		const decision = this.requireModel(modelTaskForSdkPrompt(prompt), context);
		try {
			const result = await (sdk.run as any)(agent, prompt, {
				maxTurns: this.controls.maxToolCalls + 2,
				model: decision.model,
				signal: context.signal
			});
			this.emitModelPolicyEvent(decision, context, 'model.call.completed');
			return cleanVisibleChatOutput(String(result.finalOutput || '').trim() || this.localChat(prompt), prompt);
		} catch (err) {
			this.emitModelPolicyEvent(decision, context, 'model.call.failed');
			throw err;
		}
	}

	private async *sdkStream(prompt: string, context: RuntimeContext): AsyncGenerator<string> {
		const sdk = await import('@openai/agents');
		sdk.setTracingDisabled(true);
		const agent = this.createSdkAgent(sdk, this.sdkRoleForPrompt(prompt, context), context);
		const decision = this.requireModel(modelTaskForSdkPrompt(prompt), context);
		const stream = await (sdk.run as any)(agent, prompt, {
			stream: true,
			maxTurns: this.controls.maxToolCalls + 2,
			model: decision.model,
			signal: context.signal
		});

		try {
			let output = '';
			for await (const event of stream as AsyncIterable<unknown>) {
				const delta = textDeltaFromSdkEvent(event);
				if (delta) output += delta;
				const progress = progressFromSdkEvent(event);
				if (progress) context.onProgress?.(progress);
				if (context.signal?.aborted) break;
			}
			await (stream as { completed?: Promise<void> }).completed?.catch(() => undefined);
			this.emitModelPolicyEvent(decision, context, 'model.call.completed');
			for (const chunk of splitForStreaming(cleanVisibleChatOutput(output || this.localChat(prompt), prompt))) {
				yield chunk;
			}
		} catch (err) {
			this.emitModelPolicyEvent(decision, context, 'model.call.failed');
			throw err;
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
			const sdk = await import('@openai/agents');
			sdk.setTracingDisabled(true);
			const agent = new sdk.Agent({
				name: 'Research Update Writer',
				instructions: [
					'You write the final output for a NewsCraft research update.',
					'The prompt is the output contract. Follow it exactly.',
					'Do not add default NewsCraft sections, internal process notes, or boilerplate unless the prompt asks for them.',
					'Use only the provided evidence. If the evidence is insufficient, say so in the requested format or as plainly as possible.',
					'Never invent publication dates. If a source says Published: NOT FOUND, write Date: Not found or omit the date; never use the accessed/run time as the publication date.',
					'Return only the research update.'
				].join('\n')
			});
			const response = await (sdk.run as any)(agent, missionSynthesisInput(prompt, result), {
				maxTurns: 1,
				model: decision.model,
				signal: context.signal
			});
			this.emitModelPolicyEvent(decision, context, 'model.call.completed');
			return String(response.finalOutput || '').trim() || result.final_answer;
		} catch {
			this.emitModelPolicyEvent(decision, context, 'model.call.failed');
			return result.final_answer;
		}
	}

	private createSdkAgent(sdk: typeof import('@openai/agents'), role: NewsroomRole, context: RuntimeContext) {
		const fetchTool = sdk.tool({
			name: 'url_fetch_read',
			description: 'Fetch an HTTP or HTTPS URL, extract readable text, and preserve source provenance.',
			parameters: urlFetchToolParameters(),
			execute: async ({ url }: { url: string }) => {
				assertHttpUrl(url);
				const source = await fetchSourceUrl(url, context.signal);
				context.onProgress?.({ type: 'source', source });
				if (context.repository && context.runId) {
					context.repository.storeSource({
						runId: context.runId,
						jobId: context.jobId || null,
						url: source.url,
						title: source.title,
						fetchedAt: source.fetchedAt,
						snippet: source.snippet,
						summary: source.summary,
						used: source.used,
						contentText: source.contentText,
						contentHash: source.contentHash,
						contentType: source.contentType,
						statusCode: source.statusCode,
						metadata: source.metadata ?? null,
						provenance: source.provenance ?? null
					});
				}
				return sourceToolResult(source);
			}
		});

		const snapshotTool = sdk.tool({
			name: 'source_snapshot_store',
			description: 'Store supplied source text as a provenance snapshot for the current run.',
			parameters: sourceSnapshotToolParameters(),
			execute: async ({ url, title, text }: { url: string; title?: string; text: string }) => {
				assertHttpUrl(url);
				const source = sourceFromText(url, text, title || 'Source snapshot');
				context.onProgress?.({ type: 'source', source });
				return {
					url: source.url,
					title: source.title,
					fetchedAt: source.fetchedAt,
					summary: source.summary
				};
			}
		});

		const agents = {
			assignment_desk: new sdk.Agent({
				name: 'Assignment Desk',
				instructions: chatRoleInstructions('assignment_desk'),
				tools: [fetchTool, snapshotTool]
			}),
			research: new sdk.Agent({
				name: 'Research Desk',
				instructions: chatRoleInstructions('research'),
				tools: [fetchTool, snapshotTool]
			}),
			monitoring: new sdk.Agent({
				name: 'Monitoring Desk',
				instructions: chatRoleInstructions('monitoring'),
				tools: [fetchTool, snapshotTool]
			}),
			assistant: new sdk.Agent({
				name: 'Newsroom Assistant',
				instructions: chatRoleInstructions('assistant'),
				tools: [fetchTool, snapshotTool]
			})
		};

		return agents[role] || agents.assistant;
	}

	private triageEditorCommand(prompt: string, context: RuntimeContext): AssignmentDeskDecision {
		const assignment = this.assignmentDesk.triage(prompt, { default_tool_budget: this.defaultToolBudget() });
		this.emitAssignmentDeskDecision(assignment, context);
		return assignment;
	}

	private sdkRoleForPrompt(prompt: string, context: RuntimeContext): NewsroomRole {
		if (isTitlePrompt(prompt)) return 'assistant';
		return this.triageEditorCommand(prompt, context).role;
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

export function sourceToolResult(source: FetchedSource) {
	return {
		url: source.url,
		title: source.title,
		publishedAt: source.metadata?.publishedAt ?? null,
		fetchedAt: source.fetchedAt,
		snippet: source.snippet,
		summary: source.summary,
		used: source.used,
		metadata: source.metadata ?? null,
		provenance: source.provenance ?? null
	};
}

function assertHttpUrl(value: string): void {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`invalid URL: ${value}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`unsupported URL protocol: ${parsed.protocol}`);
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

function progressDetailForTool(tool: string): string {
	if (tool === 'openai_web_search') return 'Searching current coverage';
	if (tool === 'configured_source_monitor') return 'Checking configured sources';
	if (tool === 'source_feed_fetcher') return 'Reading attached source feeds';
	if (tool === 'saved_research_reader') return 'Reading saved NewsCraft research';
	return '';
}

function chatRoleInstructions(role: NewsroomRole): string {
	return `${roleInstructionsFor(role)}

${CHAT_VISIBLE_OUTPUT_INSTRUCTIONS}`;
}

function shouldUseDisciplinedChat(prompt: string): boolean {
	return !isTitlePrompt(prompt);
}

function isTitlePrompt(prompt: string): boolean {
	return /^title for this conversation:?\s*$/i.test(prompt.trim());
}

function modelTaskForSdkPrompt(prompt: string): ModelPolicyTask {
	return isTitlePrompt(prompt) ? 'title' : 'interactive_chat';
}

export function textDeltaFromSdkEvent(event: unknown): string {
	const value = event as {
		type?: string;
		data?: {
			type?: string;
			delta?: string;
			event?: { type?: string; delta?: string };
			choices?: Array<{ delta?: { content?: string } }>;
		};
	};
	if (value.type !== 'raw_model_stream_event') return '';
	const data = value.data;
	if (data?.type === 'output_text_delta') return data.delta || '';
	if (data?.choices?.[0]?.delta?.content) return data.choices[0].delta.content || '';
	return '';
}

function progressFromSdkEvent(event: unknown): RuntimeProgressEvent | null {
	const value = event as { type?: string; name?: string; item?: { id?: string; name?: string; type?: string; status?: string } };
	if (value.type !== 'run_item_stream_event') return null;
	if (value.name !== 'tool_called' && value.name !== 'tool_output') return null;
	return {
		type: 'tool',
		id: value.item?.id || value.item?.name || 'tool',
		name: value.item?.name || value.item?.type || 'tool',
		status: value.name === 'tool_called' ? 'running' : value.item?.status || 'ok'
	};
}
