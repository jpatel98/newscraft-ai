import { describe, it, expect } from 'vitest';
import {
	dominantDoneLabel,
	dominantLiveLabel,
	doneLabel,
	formatElapsed,
	liveLabel,
	publicPlanStepDetail,
	showToolRawName,
	toolStepDetail,
	toolStepLabel,
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
		expect(liveLabel('SKILL_VIEW')).toBe('Loading skill');
		expect(doneLabel('skill_view')).toBe('Skill loaded');
		expect(liveLabel('DELEGATE_TASK')).toBe('Starting helper task');
		expect(doneLabel('delegate_task')).toBe('Helper task finished');
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
		).toBe('pnpm test -- --runInBand');
	});

	it('summarizes steps without dumping raw payloads', () => {
		expect(
			toolStepSummary({
				name: 'fetch_url',
				url: 'https://www.example.com/news/story'
			})
		).toBe('Reading source: example.com/news/story');

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
			'Queries: Informed Perspectives Canada spring economic statement budget experts Canada economy, Canada spring economic statement 2026 experts economist fiscal policy Canada contact email'
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
		).toBe('Loading skill: Skill: openai-docs');

		expect(
			toolStepSummary(
				{
					name: 'DELEGATE_TASK',
					arguments: { task: 'Check whether the test suite covers tool labels' }
				},
				true
			)
		).toBe('Helper task finished: Task: Check whether the test suite covers tool labels');

		expect(showToolRawName({ name: 'SKILL_VIEW' })).toBe(false);
		expect(showToolRawName({ name: 'DELEGATE_TASK' })).toBe(false);
	});

	it('turns browser action tools into readable running and completed steps', () => {
		expect(toolStepLabel({ name: 'browser_snapshot' })).toBe('Reading source');
		expect(toolStepLabel({ name: 'browser_snapshot' }, true)).toBe('Source read');
		expect(toolStepLabel({ name: 'browser_click', arguments: { ref: 'e56' } })).toBe(
			'Clicking page'
		);
		expect(toolStepDetail({ name: 'browser_click', arguments: { ref: 'e56' } })).toBe('e56');
		expect(showToolRawName({ name: 'browser_snapshot' })).toBe(false);
		expect(showToolRawName({ name: 'browser_click' })).toBe(false);
	});

	it('summarizes wrapped tool outputs instead of showing one result', () => {
		const result = [
			{
				type: 'input_text',
				text: JSON.stringify({
					status: 'success',
					output: '### Trevor Tombe\\nURL 200 https://profiles.ucalgary.ca/trevor-tombe\\n### Kevin Milligan\\nURL 200 https://economics.ubc.ca/profile/kevin-milligan/'
				})
			}
		];

		expect(toolStepDetail({ name: 'execute_code', result })).toBe(
			'Profiles: Trevor Tombe, Kevin Milligan'
		);
	});
});
