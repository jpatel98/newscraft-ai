import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	NewsroomAgentRuntime,
	sourceSnapshotToolParameters,
	textDeltaFromSdkEvent,
	urlFetchToolParameters
} from '../src/agents/runtime.js';

describe('newsroom agent runtime', () => {
	it('keeps OpenAI Agents SDK URL tool schemas free of rejected URL formats', () => {
		for (const parameters of [urlFetchToolParameters(), sourceSnapshotToolParameters()]) {
			const schema = z.toJSONSchema(parameters);
			const serialized = JSON.stringify(schema);

			expect(serialized).not.toContain('"format":"uri"');
			expect(serialized).not.toContain('"format":"url"');
			expect(serialized).toContain('"url"');
			expect(serialized).toContain('"type":"string"');
		}
	});

	it('does not duplicate raw and normalized SDK text deltas from one stream event', () => {
		expect(
			textDeltaFromSdkEvent({
				type: 'raw_model_stream_event',
				data: {
					type: 'output_text_delta',
					delta: 'Producer brief ready.',
					choices: [{ delta: { content: 'Producer brief ready.' } }]
				}
			})
		).toBe('Producer brief ready.');
	});

	const liveSmoke = process.env.NEWSROOM_HARNESS_LIVE_OPENAI_SMOKE === '1';
	const liveIt = liveSmoke ? it : it.skip;

	liveIt('streams a short live OpenAI response without empty output or adjacent duplicate chunks', async () => {
		expect(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY must be set for live smoke').toBeTruthy();
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 30_000,
			retryLimit: 0,
			openAiApiKey: process.env.OPENAI_API_KEY || ''
		});
		const chunks: string[] = [];
		for await (const delta of runtime.streamChat(
			[{ role: 'user', content: 'Reply with exactly: Producer smoke OK' }],
			{ model: process.env.NEWSROOM_HARNESS_SMOKE_MODEL }
		)) {
			chunks.push(delta);
		}

		const output = chunks.join('').trim();
		expect(output.length).toBeGreaterThan(0);
		expect(chunks.some((chunk, index) => chunk && index > 0 && chunks[index - 1] === chunk)).toBe(false);
	});
});
