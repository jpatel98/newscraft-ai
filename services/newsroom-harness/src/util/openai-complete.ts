export type ModelProvider = 'openai' | 'perplexity';

export interface CompleteProviderTextOptions {
	provider?: ModelProvider;
	apiKey: string;
	model: string;
	input: string;
	instructions?: string;
	reasoningEffort?: 'low' | 'medium' | 'high';
	maxOutputTokens?: number;
	signal?: AbortSignal;
}

export interface CompleteOpenAiTextOptions extends CompleteProviderTextOptions {}

/** One non-streaming Responses-compatible API call that returns the output text. */
export async function completeProviderText(options: CompleteProviderTextOptions): Promise<string> {
	const provider = options.provider || 'perplexity';
	const response = await fetch(`${providerBaseUrl(provider)}/responses`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${options.apiKey}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			model: options.model,
			input: options.input,
			...(options.instructions ? { instructions: options.instructions } : {}),
			...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
			...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {})
		}),
		signal: options.signal
	});
	const raw: { error?: { message?: string } } = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(`${providerLabel(provider)} request failed with HTTP ${response.status}: ${raw?.error?.message || response.statusText}`);
	}
	return extractOpenAiResponseText(raw);
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

export function providerBaseUrl(provider: ModelProvider): string {
	return provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.perplexity.ai/v1';
}

export function providerLabel(provider: ModelProvider): string {
	return provider === 'openai' ? 'OpenAI' : 'Perplexity';
}
