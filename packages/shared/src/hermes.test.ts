import { describe, expect, it } from 'vitest';
import { normalizePublicAgentDecision, normalizePublicAgentPlan } from './hermes';

describe('public agent activity contract', () => {
	it('projects bounded plans without private model fields or arbitrary step content', () => {
		const plan = normalizePublicAgentPlan({
			source: 'model',
			reasoning: 'private deliberation',
			steps: [
				{ id: 'read', label: 'Read the official release', status: 'running', thinking: 'hidden' },
				{ id: 'read', label: 'Check the official figures', status: 'ok' },
				{ id: '<script>', label: 'Invalid identity', status: 'running' }
			]
		});
		expect(plan).toEqual({ source: 'model', steps: [{ id: 'read', label: 'Check the official figures', status: 'ok' }] });
		expect(normalizePublicAgentPlan({ steps: [{ label: 'No stable identity' }] })).toBeNull();
	});

	it('bounds activity and redacts credentials in the deliberately public explanation', () => {
		const decision = normalizePublicAgentDecision({
			id: 'official-first', summary: 'Use official figures. Bearer test-token sk-notarealcredential123',
			stepId: 'read', reasoning: 'private deliberation', transcript: 'hidden'
		});
		expect(decision).toEqual({ id: 'official-first', summary: 'Use official figures. Bearer [redacted] [redacted]', stepId: 'read' });
		expect(normalizePublicAgentDecision({ id: 'd', reasoning: 'No public summary' })).toBeNull();
		expect(normalizePublicAgentDecision({ id: 'd', summary: 'x'.repeat(1000) })?.summary).toHaveLength(320);
		expect(normalizePublicAgentPlan({ steps: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, label: 'Read a source', status: 'pending' })) })?.steps).toHaveLength(12);
	});
});
