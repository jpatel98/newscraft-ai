import { afterEach, describe, expect, it } from 'vitest';
import { runVerificationAgent } from '../src/agents/verification.js';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	repository?.close();
	repository = null;
	db = null;
});

describe('verification agent', () => {
	it('verifies proposed claims that pass the two-source rule', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-verification';
		const storyId = 'story-verification';
		const proposed = repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'research',
			kind: 'claim.proposed',
			payload: {
				id: 'claim-two-source',
				claim: 'Council approved the overnight shuttle plan.',
				sources: [
					{ title: 'Council minutes', url: 'https://city.example/minutes' },
					{ title: 'Transit briefing', url: 'https://transit.example/briefing' }
				]
			}
		});

		const result = runVerificationAgent(repo, { workspaceId, storyId, claimEventId: proposed.id });

		expect(result).toMatchObject({
			ok: true,
			status: 'completed',
			processed_claims: [
				{
					claim_id: 'claim-two-source',
					status: 'verified'
				}
			],
			gates: []
		});
		expect(repo.listEvents({ workspaceId, storyId }).map((event) => event.kind)).toEqual([
			'claim.proposed',
			'claim.verified'
		]);
		expect(repo.inspectStoryMemory(storyId, workspaceId).current.fact_ledger).toEqual([
			expect.objectContaining({
				id: 'claim-two-source',
				status: 'verified',
				two_source_rule: { required: 2, actual: 2, passed: true }
			})
		]);
	});

	it('flags disputed counter-source claims with a verification gate', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-verification';
		const storyId = 'story-verification';
		const proposed = repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'research',
			kind: 'claim.proposed',
			payload: {
				id: 'claim-disputed',
				claim: 'The agency denied that overnight shuttle service had been approved.',
				research_intent: 'counter_source',
				target_claim: { id: 'fact-1', claim: 'The agency approved overnight shuttle service.' },
				sources: [{ title: 'Agency statement', url: 'https://sources.example/denial' }]
			}
		});

		const result = runVerificationAgent(repo, { workspaceId, storyId, claimEventId: proposed.id });

		expect(result.processed_claims[0]).toMatchObject({
			claim_id: 'claim-disputed',
			status: 'disputed',
			gate: {
				type: 'verification',
				status: 'open',
				actions: ['mark_verified', 'mark_disputed', 'request_more_research']
			}
		});
		expect(repo.listEvents({ workspaceId, storyId }).map((event) => event.kind)).toEqual([
			'claim.proposed',
			'claim.disputed',
			'gate.queued'
		]);
		expect(repo.listGates({ workspaceId, storyId })[0]).toMatchObject({
			type: 'verification',
			payload: expect.objectContaining({
				claim_id: 'claim-disputed',
				conflict_detection: expect.objectContaining({
					status: 'conflict_detected'
				})
			})
		});
	});

	it('opens a verification gate for single-source claims', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-verification';
		const storyId = 'story-verification';
		const proposed = repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'research',
			kind: 'claim.proposed',
			payload: {
				id: 'claim-single-source',
				claim: 'Council approved the overnight shuttle plan.',
				sources: [{ title: 'Council minutes', url: 'https://city.example/minutes' }]
			}
		});

		const result = runVerificationAgent(repo, { workspaceId, storyId, claimEventId: proposed.id });

		expect(result.processed_claims[0]).toMatchObject({
			claim_id: 'claim-single-source',
			status: 'needs_more',
			gate: {
				type: 'verification',
				priority: 2
			}
		});
	});

	it('does not reprocess unchanged proposed claims on story-wide verification runs', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-verification';
		const storyId = 'story-verification';
		repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'research',
			kind: 'claim.proposed',
			payload: {
				id: 'claim-idempotent',
				claim: 'Council approved the overnight shuttle plan.',
				sources: [{ title: 'Council minutes', url: 'https://city.example/minutes' }]
			}
		});

		const first = runVerificationAgent(repo, { workspaceId, storyId });
		const second = runVerificationAgent(repo, { workspaceId, storyId });

		expect(first.processed_claims).toHaveLength(1);
		expect(second).toMatchObject({
			ok: true,
			status: 'completed',
			processed_claims: []
		});
		expect(second.events[0]).toMatchObject({ kind: 'verification.no_claims' });
		expect(repo.listEvents({ workspaceId, storyId }).map((event) => event.kind)).toEqual([
			'claim.proposed',
			'claim.needs_more',
			'gate.queued',
			'verification.no_claims'
		]);
	});

	it('keeps one effective fact-ledger entry when an editor resolves a verification gate', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-verification';
		const storyId = 'story-verification';
		repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'research',
			kind: 'claim.proposed',
			payload: {
				id: 'claim-resolution',
				claim: 'Council approved the overnight shuttle plan.',
				sources: [{ title: 'Council minutes', url: 'https://city.example/minutes' }]
			}
		});
		runVerificationAgent(repo, { workspaceId, storyId });
		const gate = repo.listGates({ workspaceId, storyId })[0];

		repo.resolveGate(gate.id, {
			action: 'mark_verified',
			notes: 'Editor confirmed with the transit agency.'
		});

		expect(repo.inspectStoryMemory(storyId, workspaceId).current.fact_ledger).toEqual([
			expect.objectContaining({
				id: 'claim-resolution',
				status: 'verified',
				resolved_from_gate_id: gate.id,
				supersedes_event_id: expect.any(String)
			})
		]);
	});

	it('reopens request-more-research claims when new independent evidence arrives', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-verification';
		const storyId = 'story-verification';
		repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'research',
			kind: 'claim.proposed',
			payload: {
				claim: 'Council approved the overnight shuttle plan.',
				sources: [{ title: 'Council minutes', url: 'https://city.example/minutes' }]
			}
		});
		runVerificationAgent(repo, { workspaceId, storyId });
		const gate = repo.listGates({ workspaceId, storyId })[0];
		repo.resolveGate(gate.id, {
			action: 'request_more_research',
			notes: 'Find a second source.'
		});
		repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'research',
			kind: 'claim.proposed',
			payload: {
				claim: 'Council approved the overnight shuttle plan.',
				sources: [{ title: 'Transit briefing', url: 'https://transit.example/briefing' }]
			}
		});

		const result = runVerificationAgent(repo, { workspaceId, storyId });

		expect(result).toMatchObject({
			processed_claims: [
				{
					status: 'verified'
				}
			],
			gates: []
		});
		expect(repo.inspectStoryMemory(storyId, workspaceId).current.fact_ledger).toEqual([
			expect.objectContaining({
				status: 'verified',
				source_count: 2
			})
		]);
	});

	it('does not count two URLs from the same host as independent sources', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-verification';
		const storyId = 'story-verification';
		const proposed = repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'research',
			kind: 'claim.proposed',
			payload: {
				id: 'claim-same-host',
				claim: 'Council approved the overnight shuttle plan.',
				sources: [
					{ title: 'Council minutes', url: 'https://city.example/minutes' },
					{ title: 'Council briefing', url: 'https://city.example/briefing' }
				]
			}
		});

		const result = runVerificationAgent(repo, { workspaceId, storyId, claimEventId: proposed.id });

		expect(result.processed_claims[0]).toMatchObject({
			claim_id: 'claim-same-host',
			status: 'needs_more'
		});
		expect(result.gates).toHaveLength(1);
	});
});

function createRepository(): HarnessRepository {
	db = openDatabase(':memory:');
	repository = new HarnessRepository(db);
	return repository;
}
