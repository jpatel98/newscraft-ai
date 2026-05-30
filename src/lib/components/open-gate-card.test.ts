import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import OpenGateCard from './OpenGateCard.svelte';
import type { EditorialGate } from '$lib/types';

describe('OpenGateCard', () => {
	it('renders the reusable open gate shell for every newsroom gate type', () => {
		const source = readFileSync(new URL('./OpenGateCard.svelte', import.meta.url), 'utf8');

		for (const label of [
			'Pitch',
			'Verification',
			'Draft Review',
			'Legal / Style',
			'Publish',
			'Source Review',
			'Source Health',
			'Budget'
		]) {
			expect(source).toContain(label);
		}
		expect(source).toContain('Open Gate');
		expect(source).toContain('onResolve(gate, action, notes.trim())');
		expect(source).toContain('{#each gate.actions as action}');
	});

	it('renders draft-review citation graph behavior from payload data', () => {
		const gate: EditorialGate = {
			id: 'gate-draft-review',
			workspaceId: 'workspace-gates',
			storyId: 'story-gates',
			jobId: null,
			runId: null,
			type: 'draft_review',
			title: 'Review draft',
			summary: 'Review source-backed claims.',
			status: 'open',
			priority: 2,
			actions: ['approve', 'return_with_notes'],
			createdBy: 'drafting',
			createdAt: '2026-05-30T10:00:00.000Z',
			resolution: null,
			payload: {
				headline: 'Transit expansion',
				draft_markdown: 'Council approved the shuttle plan [1]. Agency officials disputed the approval [2].',
				citations: [
					{
						marker: 1,
						fact_id: 'fact-1',
						claim: 'Council approved the shuttle plan.',
						source_title: 'Council agenda',
						source_name: 'City Clerk',
						source_url: 'https://city.example/agenda',
						status: 'verified'
					},
					{
						marker: 2,
						fact_id: 'fact-1',
						claim: 'The agency said the shuttle plan was not approved.',
						source_title: 'Agency statement',
						source_name: 'Transit agency',
						source_url: 'https://agency.example/statement',
						status: 'disputed',
						relationship: 'contradicts'
					}
				]
			}
		};

		const { body } = render(OpenGateCard, { props: { gate, onResolve: () => undefined } });

		expect(body).toContain('Citation graph');
		expect(body).toContain('open-gate-card__citation-claim--conflict');
		expect(body).toContain('aria-pressed="true"');
		expect(body).toContain('Original source');
		expect(body).toContain('Archive fallback');
		expect(body).toContain('The agency said the shuttle plan was not approved.');
	});
});
