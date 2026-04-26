import { describe, it, expect } from 'vitest';
import {
	dominantDoneLabel,
	dominantLiveLabel,
	doneLabel,
	formatElapsed,
	liveLabel
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
});
