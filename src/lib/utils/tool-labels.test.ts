import { describe, it, expect } from 'vitest';
import {
	dominantDoneLabel,
	dominantLiveLabel,
	doneLabel,
	formatElapsed,
	liveLabel,
	showToolRawName,
	toolStepDetail,
	toolStepLabel,
	toolStepSummary
} from './tool-labels';

describe('tool labels', () => {
	it('maps search-style names to a friendly live label', () => {
		expect(liveLabel('web_search')).toBe('Searching sources');
		expect(liveLabel('google_search')).toBe('Searching sources');
	});

	it('maps fetch-style names to a friendly live label', () => {
		expect(liveLabel('fetch_url')).toBe('Reading results');
		expect(liveLabel('browse')).toBe('Reading results');
	});

	it('falls back to Working on it for unknown tools', () => {
		expect(liveLabel('synthesize_widget_42')).toBe('Working on it');
		expect(doneLabel('synthesize_widget_42')).toBe('Tools used');
	});

	it('returns "Drafting answer" when no tools are running', () => {
		expect(dominantLiveLabel([])).toBe('Drafting answer');
	});

	it('picks the dominant label across a batch of tools', () => {
		expect(
			dominantLiveLabel(['web_search', 'web_search', 'fetch_url'])
		).toBe('Searching sources');
		expect(
			dominantDoneLabel(['web_search', 'web_search', 'fetch_url'])
		).toBe('Sources checked');
	});

	it('formats elapsed time in seconds and minutes', () => {
		expect(formatElapsed(0)).toBe('0s');
		expect(formatElapsed(7_500)).toBe('7s');
		expect(formatElapsed(65_000)).toBe('1m05s');
	});

	it('adds concise step details from common tool arguments', () => {
		expect(
			toolStepDetail({
				name: 'web_search',
				arguments: { search_query: [{ q: 'city council budget vote' }] }
			})
		).toBe('Query: city council budget vote');

		expect(
			toolStepDetail({
				name: 'terminal',
				arguments: { command: 'pnpm test -- --runInBand' }
			})
		).toBe('Command: pnpm test -- --runInBand');
	});

	it('summarizes steps without dumping raw payloads', () => {
		expect(
			toolStepSummary({
				name: 'fetch_url',
				url: 'https://www.example.com/news/story'
			})
		).toBe('Reading results: Opening example.com/news/story');

		expect(
			toolStepSummary(
				{
					name: 'web_search',
					result: { count: 2 }
				},
				true
			)
		).toBe('Sources checked: 2 results');
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
			'Web search checked'
		);
		expect(toolStepDetail({ name: 'execute_code', arguments: args })).toBe(
			'Queries: Informed Perspectives Canada spring economic statement budget experts Canada economy, Canada spring economic statement 2026 experts economist fiscal policy Canada contact email'
		);
		expect(showToolRawName({ name: 'execute_code' })).toBe(false);
		expect(showToolRawName({ name: 'browser_navigate' })).toBe(false);
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
