import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	NewsroomAgentRuntime,
	type RuntimeProgressEvent,
	sourceSnapshotToolParameters,
	textDeltaFromSdkEvent,
	urlFetchToolParameters
} from '../src/agents/runtime.js';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	repository?.close();
	repository = null;
	db = null;
});

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

	it('emits assignment desk triage events before running a mission', async () => {
		db = openDatabase(':memory:');
		repository = new HarnessRepository(db);
		const job = repository.createJob({
			name: 'Mayor lookup',
			prompt: 'Who is the mayor of Toronto?',
			schedule: 'every 60m'
		});
		const run = repository.createRun(job.id, 'test');
		const progress: RuntimeProgressEvent[] = [];
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			openAiApiKey: ''
		});

		const result = await runtime.runMission(job.prompt, {
			repository,
			runId: run.id,
			jobId: job.id,
			onProgress: (event) => progress.push(event)
		});

		expect(result.role).toBe('research');
		expect(
			progress
				.filter((event) => event.type === 'tool' && event.name === 'assignment_desk')
				.map((event) => event.status)
		).toEqual(['running', 'ok']);
		const triage = repository.listEvents({ runId: run.id }).find((event) => event.kind === 'assignment.triaged');
		expect(triage).toMatchObject({
			agent: 'assignment_desk',
			job_id: job.id,
			run_id: run.id,
			payload: {
				routed_role: 'research',
				selected_mode: 'web_search',
				tools_to_use: ['openai_web_search']
			}
		});
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
