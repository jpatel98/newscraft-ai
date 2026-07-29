import { describe, expect, it } from 'vitest';
import { resolveResearchFinishStatus } from './research-outcome';

describe('research completion status', () => {
	it('does not mark a source-less current-news research run completed', () => {
		expect(
			resolveResearchFinishStatus({
				requested: 'completed',
				researchRequired: true,
				sourceCount: 0,
				citationCount: 0
			})
		).toBe('failed');
	});

	it('keeps sourced research and non-research replies completed', () => {
		expect(
			resolveResearchFinishStatus({
				requested: 'completed',
				researchRequired: true,
				sourceCount: 1,
				citationCount: 1
			})
		).toBe('completed');
		expect(
			resolveResearchFinishStatus({
				requested: 'completed',
				researchRequired: false,
				sourceCount: 0,
				citationCount: 0
			})
		).toBe('completed');
	});
});
