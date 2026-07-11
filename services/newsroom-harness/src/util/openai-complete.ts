export type ModelProvider = 'openai' | 'perplexity';

export interface CompleteProviderTextOptions {
	provider?: ModelProvider;
	apiKey: string;
	model: string;
	input: string;
	instructions?: string;
	reasoningEffort?: 'low' | 'medium' | 'high';
	maxOutputTokens?: number;
	/** Perplexity-only: force a model-only response for transformations and synthesis. */
	disableSearch?: boolean;
	signal?: AbortSignal;
}

export interface CompleteOpenAiTextOptions extends CompleteProviderTextOptions {}

export class ProviderConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProviderConfigurationError';
	}
}

/** One non-streaming provider call that returns the output text. */
export async function completeProviderText(options: CompleteProviderTextOptions): Promise<string> {
	const provider = options.provider || 'perplexity';
	const model = normalizeProviderModel(provider, options.model);
	const response = await fetch(providerTextUrl(provider), {
		method: 'POST',
		headers: {
			authorization: `Bearer ${options.apiKey}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify(providerTextBody({ ...options, provider, model })),
		signal: options.signal
	});
	const raw: { error?: { message?: string } } = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(`${providerLabel(provider)} request failed with HTTP ${response.status}: ${raw?.error?.message || response.statusText}`);
	}
	return extractProviderResponseText(provider, raw);
}

/** Backward-compatible wrapper for older call sites/tests. */
export async function completeOpenAiText(options: CompleteOpenAiTextOptions): Promise<string> {
	return completeProviderText({ ...options, provider: options.provider || 'openai' });
}

/** Output text from a Responses API response object (streaming-terminal or non-streaming). */
export function extractOpenAiResponseText(raw: unknown): string {
	const response = raw as {
		output_text?: string;
		output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
	};
	if (typeof response.output_text === 'string') return response.output_text;
	return (
		response.output
			?.flatMap((item) => item.content || [])
			.map((content) => content.text || '')
			.join('\n')
			.trim() || ''
	);
}

/** Output text from a Chat Completions/Sonar-compatible response object. */
export function extractChatCompletionText(raw: unknown): string {
	const response = raw as {
		output_text?: string;
		choices?: Array<{
			message?: { content?: unknown };
			delta?: { content?: unknown };
			text?: string;
		}>;
	};
	if (typeof response.output_text === 'string') return response.output_text;
	return (
		response.choices
			?.map((choice) => chatContentText(choice.message?.content) || chatContentText(choice.delta?.content) || choice.text || '')
			.join('\n')
			.trim() || ''
	);
}

export function extractProviderResponseText(provider: ModelProvider, raw: unknown): string {
	return provider === 'openai' ? extractOpenAiResponseText(raw) : extractChatCompletionText(raw);
}

export function normalizeProviderModel(provider: ModelProvider, model: string): string {
	const trimmed = model.trim();
	if (!trimmed) {
		throw new ProviderConfigurationError(`${providerLabel(provider)} model is not configured.`);
	}
	if (trimmed.startsWith('openai/')) {
		if (provider !== 'openai') {
			throw new ProviderConfigurationError(
				`NEWSROOM_MODEL_PROVIDER=perplexity cannot use OpenAI model "${trimmed}". Use a Perplexity Sonar model such as "sonar" or set NEWSROOM_MODEL_PROVIDER=openai.`
			);
		}
		return trimmed.slice('openai/'.length);
	}
	if (trimmed.startsWith('perplexity/')) {
		if (provider !== 'perplexity') {
			throw new ProviderConfigurationError(
				`NEWSROOM_MODEL_PROVIDER=openai cannot use Perplexity model "${trimmed}". Use an OpenAI model such as "gpt-5-mini" or set NEWSROOM_MODEL_PROVIDER=perplexity.`
			);
		}
		return trimmed.slice('perplexity/'.length);
	}
	if (provider === 'perplexity' && /^(gpt-|o\d|chatgpt-)/i.test(trimmed)) {
		throw new ProviderConfigurationError(
			`NEWSROOM_MODEL_PROVIDER=perplexity cannot use apparent OpenAI model "${trimmed}". Use a Perplexity Sonar model such as "sonar" or set NEWSROOM_MODEL_PROVIDER=openai.`
		);
	}
	if (provider === 'openai' && /^sonar(?:-|$)/i.test(trimmed)) {
		throw new ProviderConfigurationError(
			`NEWSROOM_MODEL_PROVIDER=openai cannot use apparent Perplexity model "${trimmed}". Use an OpenAI model such as "gpt-5-mini" or set NEWSROOM_MODEL_PROVIDER=perplexity.`
		);
	}
	return trimmed;
}

export function providerModelIssue(provider: ModelProvider, model: string): string | null {
	try {
		normalizeProviderModel(provider, model);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

export function providerBaseUrl(provider: ModelProvider): string {
	return provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.perplexity.ai';
}

export function providerLabel(provider: ModelProvider): string {
	return provider === 'openai' ? 'OpenAI' : 'Perplexity';
}

export function providerTextEndpoint(provider: ModelProvider): 'responses' | 'sonar' {
	return provider === 'openai' ? 'responses' : 'sonar';
}

export function providerTextUrl(provider: ModelProvider): string {
	return provider === 'openai' ? `${providerBaseUrl(provider)}/responses` : `${providerBaseUrl(provider)}/v1/sonar`;
}

function providerTextBody(options: CompleteProviderTextOptions & { provider: ModelProvider; model: string }): Record<string, unknown> {
	if (options.provider === 'openai') {
		return {
			model: options.model,
			input: options.input,
			...(options.instructions ? { instructions: options.instructions } : {}),
			...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
			...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {})
		};
	}

	return {
		model: options.model,
		messages: [
			...(options.instructions ? [{ role: 'system', content: options.instructions }] : []),
			{ role: 'user', content: options.input }
		],
		...(options.disableSearch ? { disable_search: true } : {}),
		...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {})
	};
}

function chatContentText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) => {
			if (!part || typeof part !== 'object') return '';
			const record = part as { type?: string; text?: string };
			return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
		})
		.filter(Boolean)
		.join('\n');
}
