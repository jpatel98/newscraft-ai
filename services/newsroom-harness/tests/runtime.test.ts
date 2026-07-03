import { afterEach, describe, expect, it } from 'vitest';
import {
	buildDisciplinedChatPrompt,
	NewsroomAgentRuntime,
	type RuntimeProgressEvent
} from '../src/agents/runtime.js';
import { newsroomTimeContext } from '../src/agents/time-context.js';
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
	it('anchors relative dates to Toronto local time instead of UTC', () => {
		const utcAfterMidnight = new Date(Date.UTC(2026, 5, 24, 3, 10));
		const context = newsroomTimeContext({
			now: utcAfterMidnight,
			timeZone: 'America/Toronto'
		});

		expect(context).toContain('Tuesday, June 23, 2026');
		expect(context).toContain('11:10 PM EDT');
		expect(context).toContain('Newsroom timezone: America/Toronto');

		const prompt = buildDisciplinedChatPrompt(
			[{ role: 'user', content: 'what are the fifa games played in toronto today' }],
			{ now: utcAfterMidnight, timeZone: 'America/Toronto' }
		);

		expect(prompt).toContain('Current local newsroom time: Tuesday, June 23, 2026 at 11:10 PM EDT.');
		expect(prompt).toContain('Interpret relative date phrases');
		expect(prompt).toContain('Current user question:');
		expect(prompt).toContain('what are the fifa games played in toronto today');
	});

	it('builds a bounded follow-up prompt from recent conversation context', () => {
		const prompt = buildDisciplinedChatPrompt([
			{ role: 'system', content: 'System instructions should not become follow-up context.' },
			{ role: 'user', content: 'What did Mark Carney say about recession in Canada today?' },
			{
				role: 'assistant',
				content: [
					'Pressed on GDP data showing a technical recession, Mark Carney said the data will be uneven.',
					'[NewsCraft source context for follow-up questions]',
					'Sources used:',
					'- Carney says some Canadian economic data will be uneven (investing.com)'
				].join('\n')
			},
			{ role: 'user', content: 'what are the policy shifts he is referring to?' }
		]);

		expect(prompt).toContain('Current user question:');
		expect(prompt).toContain('what are the policy shifts he is referring to?');
		expect(prompt).toContain('Recent conversation context');
		expect(prompt).toContain('Mark Carney');
		expect(prompt).toContain('investing.com');
		expect(prompt).toContain('System and newsroom instructions:');
		expect(prompt).toContain('System instructions should not become follow-up context.');
		expect(prompt.indexOf('System instructions should not become follow-up context.')).toBeLessThan(
			prompt.indexOf('Recent conversation context')
		);
	});

	it('formats fixture follow-ups from prior assistant content without rerunning research', async () => {
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: ''
		});

		const answer = await runtime.completeChat([
			{ role: 'user', content: 'what fifa games are scheduled for today' },
			{
				role: 'assistant',
				content: [
					'FIFA World Cup 2026 - Tuesday, June 16, 2026',
					'',
					'- Group G - Iran vs New Zealand',
					' - Kick-off: 2:00 a.m.',
					' - Venue: Los Angeles / Inglewood area stadium',
					'',
					'- Group I - France vs Senegal',
					' - Kick-off: 3:00 p.m.',
					' - Venue: New York / New Jersey area stadium'
				].join('\n')
			},
			{ role: 'user', content: 'give it in a proper table' }
		]);

		expect(answer).toContain('| Group | Match | Kick-off | Venue |');
		expect(answer).toContain('| Group G | Iran vs New Zealand | 2:00 a.m. | Los Angeles / Inglewood area stadium |');
		expect(answer).toContain('| Group I | France vs Senegal | 3:00 p.m. | New York / New Jersey area stadium |');
		expect(answer).not.toContain('This research update found');
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

	it('skips scheduled synthesis model calls through model policy', async () => {
		db = openDatabase(':memory:');
		repository = new HarnessRepository(db);
		const job = repository.createJob({
			name: 'Scheduled lookup',
			prompt: 'Who is the mayor of Toronto?',
			schedule: 'every 60m'
		});
		const run = repository.createRun(job.id, 'schedule');
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			openAiApiKey: 'fake-key'
		});

		await runtime.runMission(job.prompt, {
			repository,
			runId: run.id,
			jobId: job.id,
			trigger: 'schedule'
		});

		expect(
			repository.listEvents({ runId: run.id }).filter((event) => event.kind === 'model.call.skipped')
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					agent: 'model_policy',
					payload: expect.objectContaining({
						task: 'scheduled_research_update',
						reason: 'Scheduled model calls are disabled by model policy.'
					})
				})
			])
		);
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
