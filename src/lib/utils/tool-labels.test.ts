import { describe, it, expect } from 'vitest';
import { StreamEventState } from './stream-events';
import {
	dominantDoneLabel,
	dominantLiveLabel,
	doneLabel,
	formatElapsed,
	liveLabel,
	publicActivityText,
	publicPlanStepLabel,
	publicPlanStepDetail,
	showToolRawName,
	toolStepDetail,
	toolStepLabel,
	toolStepResult,
	toolStepSummary
} from './tool-labels';

describe('tool labels', () => {
	it('maps search-style names to a friendly live label', () => {
		expect(liveLabel('web_search')).toBe('Scanning coverage');
		expect(liveLabel('openai_web_search')).toBe('Scanning coverage');
		expect(liveLabel('google_search')).toBe('Scanning coverage');
	});

	it('maps assignment routing to a short planning label', () => {
		expect(liveLabel('assignment_desk')).toBe('Planning request');
		expect(doneLabel('assignment_desk')).toBe('Request routed');
	});

	it('maps fetch-style names to a friendly live label', () => {
		expect(liveLabel('fetch_url')).toBe('Reading source');
		expect(liveLabel('browse')).toBe('Reading source');
	});

	it('hides machine-style raw tool names from the main activity surface', () => {
		expect(showToolRawName({ name: 'web_search' })).toBe(false);
		expect(showToolRawName({ name: 'browser_navigate' })).toBe(false);
	});

	it('falls back to Working on it for unknown tools', () => {
		expect(liveLabel('synthesize_widget_42')).toBe('Working on it');
		expect(doneLabel('synthesize_widget_42')).toBe('Tools used');
	});

	it('maps internal skill and delegation tools to friendly labels', () => {
		expect(liveLabel('SKILL_VIEW')).toBe('Preparing research');
		expect(doneLabel('skill_view')).toBe('Research prepared');
		expect(liveLabel('DELEGATE_TASK')).toBe('Checking research');
		expect(doneLabel('delegate_task')).toBe('Research checked');
	});

	it('returns "Drafting answer" when no tools are running', () => {
		expect(dominantLiveLabel([])).toBe('Drafting answer');
	});

	it('picks the dominant label across a batch of tools', () => {
		expect(
			dominantLiveLabel(['web_search', 'web_search', 'fetch_url'])
		).toBe('Scanning coverage');
		expect(
			dominantDoneLabel(['web_search', 'web_search', 'fetch_url'])
		).toBe('Coverage scanned');
	});

	it('formats elapsed time in seconds and minutes', () => {
		expect(formatElapsed(0)).toBe('0s');
		expect(formatElapsed(7_500)).toBe('7s');
		expect(formatElapsed(65_000)).toBe('1m05s');
	});

	it('keeps failed plan details free of provider and harness internals', () => {
		expect(
			publicPlanStepDetail(
				'No browser automation provider is configured inside this harness; register one when direct page interaction is needed.'
			)
		).toBe('This research step is not available.');
		expect(publicPlanStepDetail('The source check timed out after 30 seconds.')).toBe(
			'The source check ended before it completed.'
		);
	});

	it('adds concise step details from common tool arguments', () => {
		expect(
			toolStepDetail({
				name: 'web_search',
				arguments: { search_query: [{ q: 'city council budget vote' }] }
			})
		).toBe('city council budget vote');

		expect(
			toolStepDetail({
				name: 'terminal',
				arguments: { command: 'pnpm test -- --runInBand' }
			})
		).toBe('');
	});

	it('summarizes steps without dumping raw payloads', () => {
		expect(
			toolStepSummary({
				name: 'fetch_url',
				url: 'https://www.example.com/news/story'
			})
		).toBe('Reading source: example.com');

		expect(
			toolStepSummary(
				{
					name: 'web_search',
					result: { count: 2 }
				},
				true
			)
		).toBe('Coverage scanned: 2 results');
	});

	it('shows public outcomes without command output or workspace paths', () => {
		expect(toolStepResult({ name: 'web_search', arguments: { query: 'city budget' }, result: { results: [{}, {}] } })).toBe('2 results');
		expect(toolStepResult({ name: 'terminal', result: { exit_code: 0, stdout: 'Found 3 files\nBearer fixture-secret' } })).toBe('Completed.');
		expect(toolStepResult({ name: 'write_file', result: { bytes: 2048 } })).toBe('File saved.');
		expect(toolStepResult({ name: 'publish_csv', result: { workspace_path: '/workspace/outputs/data.csv' } })).toBe('File saved.');
		expect(toolStepLabel({ name: 'browser', arguments: { action: 'navigate', url: 'https://example.com/source' } }, true)).toBe('Page opened');
	});

	it('turns internal expert-search code calls into readable steps', () => {
		const args = JSON.stringify({
			code: `queries = [
 'Informed Perspectives Canada spring economic statement budget experts Canada economy',
 'Canada spring economic statement 2026 experts economist fiscal policy Canada contact email'
]
print('duckduckgo')`
		});

		expect(toolStepLabel({ name: 'execute_code', arguments: args }, true)).toBe(
			'Coverage scanned'
		);
		expect(toolStepDetail({ name: 'execute_code', arguments: args })).toBe(
			'Queries: Informed Perspectives Canada spring economic statement budget experts Canada economy...'
		);
		expect(showToolRawName({ name: 'execute_code' })).toBe(false);
		expect(showToolRawName({ name: 'browser_navigate' })).toBe(false);
	});

	it('summarizes skill and delegated task steps without raw internal names', () => {
		expect(
			toolStepSummary({
				name: 'SKILL_VIEW',
				arguments: { skill_name: 'openai-docs' }
			})
		).toBe('Preparing research');

		expect(
			toolStepSummary(
				{
					name: 'DELEGATE_TASK',
					arguments: { task: 'Check whether the test suite covers tool labels' }
				},
				true
			)
		).toBe('Research checked');

		expect(showToolRawName({ name: 'SKILL_VIEW' })).toBe(false);
		expect(showToolRawName({ name: 'DELEGATE_TASK' })).toBe(false);
	});

	it('turns browser action tools into readable running and completed steps', () => {
		expect(toolStepLabel({ name: 'browser_snapshot' })).toBe('Reading source');
		expect(toolStepLabel({ name: 'browser_snapshot' }, true)).toBe('Source read');
		expect(toolStepLabel({ name: 'browser_click', arguments: { ref: 'e56' } })).toBe(
			'Clicking page'
		);
		expect(toolStepDetail({ name: 'browser_click', arguments: { ref: 'e56' } })).toBe('');
		expect(showToolRawName({ name: 'browser_snapshot' })).toBe(false);
		expect(showToolRawName({ name: 'browser_click' })).toBe(false);
	});

	it('does not display wrapped historical execution output', () => {
		const result = [
			{
				type: 'input_text',
				text: JSON.stringify({
					status: 'success',
					output: '### Trevor Tombe\\nURL 200 https://profiles.ucalgary.ca/trevor-tombe\\n### Kevin Milligan\\nURL 200 https://economics.ubc.ca/profile/kevin-milligan/'
				})
			}
		];

		expect(toolStepDetail({ name: 'execute_code', result })).toBe('');
	});

	it('keeps live and reloaded action details free of commands, paths and private references', () => {
		const calls = [
			{ name: 'terminal', detail: 'cat /workspace/private.md', arguments: { command: 'cat /workspace/private.md' }, result: { exit_code: 0, stdout: 'private-file-contents', stderr: 'private-error-details' } },
			{ name: 'write_file', detail: '/workspace/private.md', arguments: { path: '/workspace/private.md' }, result: { bytes: 123, workspace_path: '/workspace/private.md' } },
			{ name: 'browser', arguments: { action: 'click', selector: '#private-selector', ref: 'e56' }, result: { text: 'raw-page-output', navigation_id: 'private-navigation', receipt_id: 'private-receipt' } },
			{ name: 'execute_code', arguments: { code: "print('private-output')" }, result: { output: 'private-output' } },
			{ name: 'opaque_tool', detail: 'private-tool-detail', result: { message: 'private-tool-output' } }
		];
		for (const call of calls) {
			for (const replay of [call, { ...call, arguments: JSON.stringify(call.arguments), result: JSON.stringify(call.result) }]) {
				const displayed = [toolStepDetail(replay), toolStepResult(replay), toolStepSummary(replay, true)].join(' ');
				expect(displayed).not.toMatch(/private-|\/workspace|cat |exit code|e56|opaque_tool|execute_code/i);
				expect(showToolRawName(replay)).toBe(false);
			}
		}
	});

	it('does not let explicit metadata or diagnostic results bypass research detail rules', () => {
		for (const detail of ['cat /workspace/secret.txt', 'web_search call_private', 'request e56', 'HTTP 500 traceback', 'run-opaque-123']) {
			expect(toolStepDetail({ name: 'web_search', detail })).toBe('');
			expect(toolStepDetail({ name: 'fetch_url', title: detail })).toBe('');
			expect(toolStepResult({ name: 'web_search', result: { summary: detail, message: detail, text: detail } })).toBe('');
		}
		expect(toolStepResult({ name: 'terminal', result: { exit_code: 2, stderr: '/private/tmp/diagnostics' } })).toBe('This action could not be completed.');
		expect(toolStepResult({ name: 'web_search', result: { error: 'Provider HTTP 500 /private/tmp/diagnostics' } })).toBe('This action could not be completed.');
	});

	it('preserves useful queries and source domains without source credentials or identifiers', () => {
		expect(toolStepDetail({ name: 'web_search', arguments: { query: 'Toronto council budget vote' } })).toBe('Toronto council budget vote');
		expect(toolStepDetail({ name: 'fetch_url', arguments: { url: 'https://www.example.com/private-document-id?token=private-token#private-fragment' } })).toBe('example.com');
		expect(toolStepDetail({ name: 'fetch_url', url: 'https://user:private-password@example.com/' })).toBe('');
		expect(toolStepDetail({ name: 'fetch_url', url: 'file:///workspace/private.txt' })).toBe('');
		expect(toolStepDetail({ name: 'fetch_url', url: '/workspace/private.txt' })).toBe('');
		const browserSource = { name: 'browser', arguments: { action: 'navigate', url: 'https://example.com/story' }, result: { publishedAt: '2026-10-01T12:00:00Z', fetchedAt: '2026-10-07T12:00:00Z' } };
		expect(toolStepDetail(browserSource)).toBe('example.com');
		expect(browserSource.result).toEqual({ publishedAt: '2026-10-01T12:00:00Z', fetchedAt: '2026-10-07T12:00:00Z' });
	});

	it('sanitizes persisted plan labels, details and work notes at the display boundary', () => {
		for (const text of ['Read /workspace/private.txt', 'Saved reports/private.md', 'Read ./reports/private.md', 'Read C:\\private\\report.txt', 'Use web_search', 'Use receipt_private', 'Run ID abc123', 'Inspect e56', 'Resume 123e4567-e89b-12d3-a456-426614174000', 'Run pnpm test', 'Inspect API key configuration']) {
			expect(publicActivityText(text)).toBe('');
			expect(publicPlanStepLabel(text)).toBe('Researching');
			expect(publicPlanStepDetail(text)).not.toBe(text);
		}
		expect(publicActivityText('Prefer the official release and compare the figures.')).toBe('Prefer the official release and compare the figures.');
		expect(publicPlanStepLabel('Read the official budget release')).toBe('Read the official budget release');
		expect(publicPlanStepDetail('The source requires a subscription.')).toBe('A source could not be read because access was restricted.');
	});

	it('projects reconnected SSE metadata and its saved JSON through the same public boundary', () => {
		const state = new StreamEventState();
		const event = JSON.stringify({ tool: 'terminal', id: 'call_private', status: 'done',
			detail: 'cat /workspace/private.md', arguments: { command: 'cat /workspace/private.md' },
			result: { exit_code: 0, stdout: 'private-file-contents', workspace_path: '/workspace/private.md' } });
		state.apply('agent.tool.progress', event);
		state.apply('agent.tool.progress', event);
		state.apply('agent.plan', JSON.stringify({ steps: [{ id: 'read', label: 'Read /workspace/private.md', status: 'ok' }] }));
		state.apply('agent.decision', JSON.stringify({ id: 'decision', summary: 'Use receipt_private' }));
		expect(state.toolCalls()).toHaveLength(1);
		const saved = JSON.parse(JSON.stringify({ tools: state.toolCalls(), plan: state.planSnapshot(), decisions: state.decisionList() }));
		for (const tool of [state.toolCalls()[0], saved.tools[0]]) {
			expect(toolStepDetail(tool)).toBe('');
			expect(toolStepSummary(tool, true)).toBe('Data processed');
			expect(toolStepResult(tool)).toBe('Completed.');
		}
		expect(publicPlanStepLabel(saved.plan.steps[0].label)).toBe('Researching');
		expect(publicActivityText(saved.decisions[0].summary)).toBe('');
	});
});
