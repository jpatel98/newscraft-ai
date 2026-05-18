import type { GatewayChatMessage, ReasoningEffort } from '@newscraft/shared';
import { z } from 'zod';
import { chooseRole, roleLabel, ROLE_INSTRUCTIONS, type NewsroomRole } from './roles.js';
import { fetchSourceUrl, sourceFromText, type FetchedSource } from '../tools/sources.js';
import { extractUrls, firstUrl, promptFromChatMessages, splitForStreaming } from '../util/text.js';
import type { HarnessRepository } from '../db/repository.js';

export interface RuntimeControls {
	maxToolCalls: number;
	runTimeoutMs: number;
	retryLimit: number;
	openAiApiKey: string;
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
}

export function httpUrlToolParameter(description: string) {
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
		const sources: FetchedSource[] = [];
		const urls = extractUrls(prompt).slice(0, Math.max(1, this.controls.maxToolCalls));
		let toolCalls = 0;

		for (const url of urls) {
			if (toolCalls >= this.controls.maxToolCalls) break;
			toolCalls += 1;
			const toolId = `${context.runId || 'run'}_fetch_${toolCalls}`;
			context.onProgress?.({ type: 'tool', id: toolId, name: 'url_fetch_read', status: 'running', detail: url });
			try {
				const source = await this.withToolTimeout((signal) => fetchSourceUrl(url, signal), context.signal);
				sources.push(source);
				context.onProgress?.({ type: 'source', source });
				context.onProgress?.({
					type: 'tool',
					id: toolId,
					name: 'url_fetch_read',
					status: 'ok',
					detail: source.title,
					result: { url: source.url, title: source.title }
				});
			} catch (err) {
				context.onProgress?.({
					type: 'tool',
					id: toolId,
					name: 'url_fetch_read',
					status: 'failed',
					detail: err instanceof Error ? err.message : String(err)
				});
			}
		}

		let body: string;
		if (this.controls.openAiApiKey) {
			body = await this.withTimeout(
				() => this.sdkComplete(missionPrompt(prompt, role, sources), context),
				context.signal
			);
		} else {
			body = localMissionMarkdown(prompt, role, sources);
		}

		return { role, markdown: body, sources };
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
						statusCode: source.statusCode
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
				instructions: ROLE_INSTRUCTIONS.assignment_desk,
				tools: [fetchTool, snapshotTool]
			}),
			research: new sdk.Agent({
				name: 'Research Desk',
				instructions: ROLE_INSTRUCTIONS.research,
				tools: [fetchTool, snapshotTool]
			}),
			verification: new sdk.Agent({
				name: 'Verification Desk',
				instructions: ROLE_INSTRUCTIONS.verification,
				tools: [fetchTool, snapshotTool]
			}),
			production: new sdk.Agent({
				name: 'Production Desk',
				instructions: ROLE_INSTRUCTIONS.production,
				tools: [fetchTool, snapshotTool]
			}),
			monitoring: new sdk.Agent({
				name: 'Monitoring Desk',
				instructions: ROLE_INSTRUCTIONS.monitoring,
				tools: [fetchTool, snapshotTool]
			}),
			assistant: new sdk.Agent({
				name: 'Newsroom Assistant',
				instructions: ROLE_INSTRUCTIONS.assistant,
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

function missionPrompt(prompt: string, role: NewsroomRole, sources: FetchedSource[]): string {
	const sourceBlock = sources.length
		? sources
				.map((source, index) => `${index + 1}. ${source.title}\n${source.url}\n${source.summary}`)
				.join('\n\n')
		: 'No sources were fetched before synthesis.';
	return `${ROLE_INSTRUCTIONS[role]}

Task:
${prompt}

Fetched source provenance:
${sourceBlock}

Write a concise markdown mission report for an editor. Include sections for Summary, Source Notes, Verification Notes, and Human Review. Do not publish anything.`;
}

function localMissionMarkdown(prompt: string, role: NewsroomRole, sources: FetchedSource[]): string {
	const sourceLines = sources.length
		? sources.map((source) => `- [${source.title}](${source.url}) fetched ${source.fetchedAt}: ${source.summary}`)
		: ['- No external source URLs were configured or fetched for this run.'];
	return `## Summary

NewsCraft ${roleLabel(role)} completed a draft mission run for:

> ${prompt.split('\n')[0]?.slice(0, 280) || 'Untitled mission'}

${sources.length ? `The harness fetched ${sources.length} source${sources.length === 1 ? '' : 's'} and preserved snapshots in its run log.` : 'The harness produced a deterministic local report because no source URL was available.'}

## Source Notes

${sourceLines.join('\n')}

## Verification Notes

- Treat this as an editor-facing draft, not a publishable final.
- Confirm any factual claims against primary sources before use.
- No CMS, social, or publishing action was taken.

## Human Review

An editor must approve story angle, sourcing, legal/privacy sensitivity, and publication decisions.`;
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
