import { describe, expect, it } from 'vitest';
import type { ConversationContext, ConversationOperation } from '@newscraft/shared';
import { normalizeEvidence, type EvidenceObject } from '../src/agents/evidence.js';
import { DisciplinedNewsroomAgent } from '../src/agents/newsroom-agent.js';
import { ToolRegistry, type NewsroomTool } from '../src/agents/tools.js';

describe('general-purpose conversational research regressions', () => {
	it('uses the authoritative latest request for every tool query', async () => {
		const queries: string[] = [];
		const agent = agentWithSearch(async (input) => {
			queries.push(input.query);
			return sourced('Ottawa housing vote passed after a recorded council vote.');
		});

		await agent.run('Summarize the earlier Calgary arena prompt', {
			outputStyle: 'chat',
			routingPrompt: 'Summarize the earlier Calgary arena prompt',
			conversationContext: context('What is the latest on the Ottawa housing vote?', 'Ottawa')
		});

		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain('What is the latest on the Ottawa housing vote?');
		expect(queries[0]).not.toContain('Calgary arena');
	});

	it('returns supported partial findings with an honest limitation', async () => {
		const agent = agentWithSearch(async () => ({
			status: 'ok',
			evidence: [
				evidence(
					'Company confirms Windsor battery-recycling site',
					'https://company.example/news/windsor-site',
					'The company confirmed Windsor as the site for a battery-recycling plant.',
					'primary',
					{ location: 'Windsor', limitations: ['The construction schedule was not disclosed.'] }
				)
			],
			answer: 'The company confirmed Windsor as the site for a battery-recycling plant [1].',
			limitations: ['The construction schedule was not disclosed.']
		}));

		const result = await agent.run('What is the latest on the Windsor battery-recycling plant?', {
			outputStyle: 'chat',
			conversationContext: context('What is the latest on the Windsor battery-recycling plant?', 'Windsor')
		});

		expect(result.evidence).toHaveLength(1);
		expect(result.final_answer).toContain('confirmed Windsor as the site');
		expect(result.final_answer).toContain('[1]');
		expect(result.final_answer).not.toContain("couldn't verify this from readable sources");
	});

	it('states explicit uncertainty when accepted sources conflict', async () => {
		const agent = agentWithSearch(async () => ({
			status: 'ok',
			evidence: [
				evidence(
					'Agency statement',
					'https://agency.example/releases/program',
					'The agency says the grant program will launch on Monday.',
					'official'
				),
				evidence(
					'Association response',
					'https://association.example/response',
					'The association says the grant program will not launch on Monday.',
					'primary'
				)
			]
		}));

		const result = await agent.run('Verify when the grant program will launch.', {
			outputStyle: 'chat',
			conversationContext: context('Verify when the grant program will launch.')
		});

		expect(result.final_answer).toContain('sources conflict');
		expect(result.final_answer).toContain('remains uncertain');
		expect(result.final_answer).toContain('[1]');
		expect(result.final_answer).toContain('[2]');
	});

	it('keeps citation ordering deterministic across retry and regeneration', async () => {
		const queries: string[] = [];
		const agent = agentWithSearch(async (input) => {
			queries.push(input.query);
			return {
				status: 'ok',
				evidence: [
					evidence('Second source', 'https://b.example/item', 'The port reopened one terminal.', 'news_report'),
					evidence('First source', 'https://a.example/item', 'The port authority reopened one terminal.', 'official')
				]
			};
		});
		const request = 'What is the latest on the Halifax port reopening?';
		const retry = await agent.run('stale transport prompt', {
			outputStyle: 'chat',
			conversationContext: context(request, 'Halifax', 'retry')
		});
		const regeneration = await agent.run('different stale prompt', {
			outputStyle: 'chat',
			conversationContext: context(request, 'Halifax', 'regenerate')
		});

		expect(queries).toHaveLength(2);
		expect(queries[0]).toBe(queries[1]);
		expect(queries[0]).toContain(request);
		expect(queries[0]).not.toContain('stale transport prompt');
		expect(queries[0]).not.toContain('different stale prompt');
		expect(retry.evidence.map((item) => item.source_url)).toEqual(
			regeneration.evidence.map((item) => item.source_url)
		);
		expect(retry.evidence.map((item) => item.citation_number)).toEqual([1, 2]);
		expect(regeneration.evidence.map((item) => item.citation_number)).toEqual([1, 2]);
		expect(retry.final_answer).toBe(regeneration.final_answer);
	});

	it('hard-rejects unrelated evidence without discarding the relevant source', async () => {
		const agent = agentWithSearch(async () => ({
			status: 'ok',
			evidence: [
				evidence(
					'Ottawa housing vote',
					'https://ottawa.example/housing',
					'Ottawa council approved the housing motion.',
					'news_report',
					{ location: 'Ottawa' }
				),
				evidence(
					'Calgary arena vote',
					'https://calgary.example/arena',
					'Calgary council approved arena financing.',
					'news_report',
					{ location: 'Calgary' }
				)
			]
		}));

		const result = await agent.run('What is the latest on the Ottawa housing vote?', {
			outputStyle: 'chat',
			conversationContext: context('What is the latest on the Ottawa housing vote?', 'Ottawa')
		});

		expect(result.evidence.map((item) => item.source_url)).toEqual(['https://ottawa.example/housing']);
		expect(result.limitations.join(' ')).toContain('excluded');
	});
});

function agentWithSearch(
	run: (input: { query: string }) => Promise<{
		status: 'ok' | 'unavailable' | 'blocked' | 'error';
		evidence?: EvidenceObject[];
		answer?: string;
		limitations?: string[];
	}>
): DisciplinedNewsroomAgent {
	const registry = new ToolRegistry();
	const tool: NewsroomTool<{ query: string }> = {
		name: 'openai_web_search',
		description: 'Fixture search',
		when_to_use: 'Test only',
		category: 'web_search_provider',
		input_schema: { type: 'object' },
		output_schema: { type: 'object' },
		run
	};
	registry.register(tool);
	return new DisciplinedNewsroomAgent({
		registry,
		config: { enabled_tools: ['openai_web_search'], planner_enabled: false }
	});
}

function context(
	request: string,
	location?: string,
	operation: ConversationOperation = 'send'
): ConversationContext {
	return {
		version: 1,
		intent: 'research',
		currentTurn: {
			messageId: 'latest-user-message',
			content: request,
			resolvedRequest: request,
			operation,
			researchRequired: true,
			freshness: 'current'
		},
		activeTopic: {
			subject: request,
			...(location ? { location } : {}),
			relevantDate: 'current'
		}
	};
}

function sourced(text: string) {
	return {
		status: 'ok' as const,
		evidence: [evidence('Official update', 'https://official.example/update', text, 'official')]
	};
}

function evidence(
	title: string,
	url: string,
	text: string,
	kind: 'official' | 'primary' | 'news_report',
	options: { location?: string; limitations?: string[] } = {}
): EvidenceObject {
	return normalizeEvidence({
		source_name: new URL(url).hostname,
		source_url: url,
		tool_used: 'openai_web_search',
		title,
		published_at: new Date().toISOString(),
		extracted_text: text,
		summary: text,
		source_kind: kind,
		location: options.location ?? null,
		limitations: options.limitations ?? []
	});
}
