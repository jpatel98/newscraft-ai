import type { GatewayChatMessage, ReasoningEffort } from '@newscraft/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { chooseRole, roleInstructionsFor, roleLabel, type NewsroomRole } from './roles.js';
import { DisciplinedNewsroomAgent, type NewsroomAgentRunResult } from './newsroom-agent.js';
import type { EvidenceObject } from './evidence.js';
import type { NewsroomAgentConfig } from './harness-config.js';
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
	constructor(private controls: RuntimeControls) {}

	async completeChat(messages: GatewayChatMessage[], context: RuntimeContext = {}): Promise<string> {
		const prompt = promptFromChatMessages(messages);
		if (!this.controls.openAiApiKey) return this.localChat(prompt);
		return this.withTimeout(() => this.sdkComplete(prompt, context), context.signal);
	}

	async *streamChat(messages: GatewayChatMessage[], context: RuntimeContext = {}): AsyncGenerator<string> {
		const prompt = promptFromChatMessages(messages);
		if (!this.controls.openAiApiKey) {
			for (const chunk of splitForStreaming(this.localChat(prompt))) yield chunk;
			return;
		}
		yield* this.sdkStream(prompt, context);
	}

	async runMission(prompt: string, context: RuntimeContext): Promise<MissionRuntimeResult> {
		const role = chooseRole(prompt);
		const agent = new DisciplinedNewsroomAgent({
			config: {
				...this.controls.agentConfig,
				default_tool_budget: {
					max_total_tool_calls: this.controls.maxToolCalls,
					max_custom_tool_calls: Math.min(4, this.controls.maxToolCalls),
					max_web_searches: 3,
					max_browser_tasks: 2,
					max_runtime_seconds: Math.ceil(this.controls.runTimeoutMs / 1000)
				}
			},
			repository: context.repository,
			openAiApiKey: this.controls.openAiApiKey
		});
		const result = await agent.run(prompt, {
			repository: context.repository,
			openAiApiKey: this.controls.openAiApiKey,
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
		const role = chooseRole(prompt);
		const url = firstUrl(prompt);
		return [
			`NewsCraft ${roleLabel(role)} ready.`,
			url
				? `I can use ${url} as a source and keep provenance in the harness run log.`
				: 'I can scan, summarize, draft, verify, and prepare reports while leaving publishing decisions to an editor.',
			'For live model-backed analysis, set OPENAI_API_KEY on the newsroom harness.'
		].join('\n\n');
	}

	private async sdkComplete(prompt: string, context: RuntimeContext): Promise<string> {
		const sdk = await import('@openai/agents');
		sdk.setTracingDisabled(true);
		const agent = this.createSdkAgent(sdk, chooseRole(prompt), context);
		const result = await (sdk.run as any)(agent, prompt, {
			maxTurns: this.controls.maxToolCalls + 2,
			model: context.model,
			signal: context.signal
		});
		return String(result.finalOutput || '').trim() || this.localChat(prompt);
	}

	private async *sdkStream(prompt: string, context: RuntimeContext): AsyncGenerator<string> {
		const sdk = await import('@openai/agents');
		sdk.setTracingDisabled(true);
		const agent = this.createSdkAgent(sdk, chooseRole(prompt), context);
		const stream = await (sdk.run as any)(agent, prompt, {
			stream: true,
			maxTurns: this.controls.maxToolCalls + 2,
			model: context.model,
			signal: context.signal
		});

		for await (const event of stream as AsyncIterable<unknown>) {
			const delta = textDeltaFromSdkEvent(event);
			if (delta) yield delta;
			const progress = progressFromSdkEvent(event);
			if (progress) context.onProgress?.(progress);
			if (context.signal?.aborted) break;
		}
		await (stream as { completed?: Promise<void> }).completed?.catch(() => undefined);
	}

	private async synthesizeMissionOutput(
		prompt: string,
		result: NewsroomAgentRunResult,
		context: RuntimeContext
	): Promise<string> {
		if (!this.controls.openAiApiKey) return result.final_answer;
		try {
			const sdk = await import('@openai/agents');
			sdk.setTracingDisabled(true);
			const agent = new sdk.Agent({
				name: 'Cron Mission Output Writer',
				instructions: [
					'You write the final output for a scheduled newsroom cron mission.',
					'The mission prompt is the output contract. Follow it exactly.',
					'Do not add default NewsCraft sections, source notes, verification notes, human-review notes, or boilerplate unless the mission prompt asks for them.',
					'Use only the provided evidence. If the evidence is insufficient, say so in the requested format or as plainly as possible.',
					'Return only the mission output.'
				].join('\n')
			});
			const response = await (sdk.run as any)(agent, missionSynthesisInput(prompt, result), {
				maxTurns: 1,
				model: context.model,
				signal: context.signal
			});
			return String(response.finalOutput || '').trim() || result.final_answer;
		} catch {
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
						healthGate: source.healthGate ?? null
					});
				}
				return {
					url: source.url,
					title: source.title,
					fetchedAt: source.fetchedAt,
					snippet: source.snippet,
					summary: source.summary,
					used: source.used
				};
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
				instructions: roleInstructionsFor('assignment_desk'),
				tools: [fetchTool, snapshotTool]
			}),
			research: new sdk.Agent({
				name: 'Research Desk',
				instructions: roleInstructionsFor('research'),
				tools: [fetchTool, snapshotTool]
			}),
			verification: new sdk.Agent({
				name: 'Verification Desk',
				instructions: roleInstructionsFor('verification'),
				tools: [fetchTool, snapshotTool]
			}),
			production: new sdk.Agent({
				name: 'Production Desk',
				instructions: roleInstructionsFor('production'),
				tools: [fetchTool, snapshotTool]
			}),
			monitoring: new sdk.Agent({
				name: 'Monitoring Desk',
				instructions: roleInstructionsFor('monitoring'),
				tools: [fetchTool, snapshotTool]
			}),
			assistant: new sdk.Agent({
				name: 'Newsroom Assistant',
				instructions: roleInstructionsFor('assistant'),
				tools: [fetchTool, snapshotTool]
			})
		};

		return agents[role] || agents.assistant;
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
		healthGate: null
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
						item.published_at ? `Published: ${item.published_at}` : null,
						`Accessed: ${item.accessed_at}`,
						`Text: ${truncateEvidence(item.extracted_text || item.summary || item.title)}`
					]
						.filter(Boolean)
						.join('\n')
				)
				.join('\n\n')
		: 'No usable evidence was gathered.';
	const limitations = result.limitations.length ? result.limitations.join('\n') : 'None recorded.';
	return `Mission prompt:
${prompt}

Evidence gathered for this run:
${evidence}

Limitations:
${limitations}

Write the mission output now. Follow the mission prompt's requested output format exactly.`;
}

function truncateEvidence(value: string, maxLength = 1800): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, maxLength - 1).trim()}…`;
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
