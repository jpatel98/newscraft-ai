import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('OpenGateCard', () => {
	it('renders the reusable open gate shell for every newsroom gate type', () => {
		const source = readFileSync(new URL('./OpenGateCard.svelte', import.meta.url), 'utf8');

		for (const label of [
			'Pitch',
			'Verification',
			'Draft Review',
			'Legal / Style',
			'Publish',
			'Crawl Plan',
			'Source Health',
			'Budget'
		]) {
			expect(source).toContain(label);
		}
		expect(source).toContain('Open Gate');
		expect(source).toContain('onResolve(gate, action, notes.trim())');
		expect(source).toContain('{#each gate.actions as action}');
	});

	it('renders draft-review payload citations with original and archive links', () => {
		const source = readFileSync(new URL('./OpenGateCard.svelte', import.meta.url), 'utf8');

		expect(source).toContain('draftReviewPayloadFromValue(gate.payload)');
		expect(source).toContain('segmentDraftWithCitations(draftReview.markdown, draftReview.citations)');
		expect(source).toContain('Open source details for citation');
		expect(source).toContain('selectedCitation.sourceUrl');
		expect(source).toContain('selectedCitation.archiveUrl');
		expect(source).toContain('Archive fallback');
	});
});
