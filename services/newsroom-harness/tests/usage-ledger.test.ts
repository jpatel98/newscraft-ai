import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNewsroomAgentConfig } from '../src/agents/harness-config.js';
import { NEWSROOM_TOOL_NAMES, routeNewsroomRequest } from '../src/agents/router.js';
import { createDefaultToolRegistry } from '../src/agents/default-tools.js';
import { ToolBudgetLedger, mergeToolBudget } from '../src/agents/budget.js';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	repository?.close();
	repository = null;
	db = null;
});

describe('provider usage ledger', () => {
	it('appends and lists usage records directly', () => {
		repository = new HarnessRepository(openDatabase(':memory:'));

		const record = repository.appendUsageRecord({
			workspaceId: 'workspace-a',
			task: 'web_search',
			provider: 'openai',
			model: 'gpt-5-mini',
			endpoint: '/v1/responses',
			status: 'completed',
			latencyMs: 123.8,
			usageMetadata: { input_tokens: 12, output_tokens: 4 },
			costMetadata: { estimated: false }
		});

		expect(record).toMatchObject({
			workspace_id: 'workspace-a',
			job_id: null,
			run_id: null,
			task: 'web_search',
			provider: 'openai',
			model: 'gpt-5-mini',
			endpoint: '/v1/responses',
			status: 'completed',
			latency_ms: 123,
			usage_metadata: { input_tokens: 12, output_tokens: 4 },
			cost_metadata: { estimated: false }
		});
		expect(repository.listUsageRecords({ workspaceId: 'workspace-a' })).toEqual([record]);
	});

	it('writes a ledger row for successful provider web search calls', async () => {
		repository = new HarnessRepository(openDatabase(':memory:'));
		const run = createLedgerRun(repository);
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							output_text: 'The source-backed search answer.',
							usage: { input_tokens: 20, output_tokens: 6, total_tokens: 26 }
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					)
			)
		);

		const output = await runWebSearchTool(repository, run.jobId, run.runId);

		expect(output.status).toBe('ok');
		const records = repository.listUsageRecords({ runId: run.runId });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			workspace_id: 'default',
			job_id: run.jobId,
			run_id: run.runId,
			task: NEWSROOM_TOOL_NAMES.webSearch,
			provider: 'openai',
			model: 'gpt-5-mini',
			endpoint: 'responses',
			status: 'completed',
			usage_metadata: { input_tokens: 20, output_tokens: 6, total_tokens: 26 }
		});
		expect(records[0].latency_ms).toEqual(expect.any(Number));
		expect(records[0].event_id).toEqual(expect.stringMatching(/^event_/));
	});

	it('writes a ledger row for failed provider web search calls', async () => {
		repository = new HarnessRepository(openDatabase(':memory:'));
		const run = createLedgerRun(repository);
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: { message: 'provider unavailable' } }), {
						status: 503,
						statusText: 'Service Unavailable',
						headers: { 'content-type': 'application/json' }
					})
			)
		);

		const output = await runWebSearchTool(repository, run.jobId, run.runId);

		expect(output.status).toBe('error');
		const records = repository.listUsageRecords({ runId: run.runId });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			job_id: run.jobId,
			run_id: run.runId,
			task: NEWSROOM_TOOL_NAMES.webSearch,
			provider: 'openai',
			model: 'gpt-5-mini',
			endpoint: 'responses',
			status: 'failed',
			usage_metadata: {}
		});
		expect(records[0].cost_metadata).toMatchObject({
			provider: 'openai',
			model: 'gpt-5-mini',
			tool: NEWSROOM_TOOL_NAMES.webSearch,
			estimated: false
		});
	});
});

function createLedgerRun(repo: HarnessRepository): { jobId: string; runId: string } {
	const job = repo.createJob({
		name: 'Ledger test',
		prompt: 'Search current coverage.',
		schedule: 'every 60m'
	});
	const run = repo.createRun(job.id, 'test');
	return { jobId: job.id, runId: run.id };
}

async function runWebSearchTool(repo: HarnessRepository, jobId: string, runId: string) {
	const config = createNewsroomAgentConfig({
		enabled_tools: [NEWSROOM_TOOL_NAMES.webSearch],
		model_provider: 'openai',
		web_search_model: 'openai/gpt-5-mini',
		planner_enabled: false,
		model_policy: {
			models: {
				nano: 'openai/gpt-5-mini',
				mini: 'openai/gpt-5-mini',
				standard: 'openai/gpt-5-mini',
				web_search: 'openai/gpt-5-mini'
			}
		}
	});
	const tool = createDefaultToolRegistry().require(NEWSROOM_TOOL_NAMES.webSearch);
	return tool.run(
		{ query: 'latest Toronto city hall update' },
		{
			prompt: 'latest Toronto city hall update',
			decision: routeNewsroomRequest('latest Toronto city hall update'),
			config,
			evidence: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			repository: repo,
			jobId,
			runId,
			modelProvider: 'openai',
			modelApiKey: 'fake-key',
			openAiApiKey: 'fake-key',
			trigger: 'test'
		}
	);
}
