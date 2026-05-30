import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	repository?.close();
	repository = null;
	db = null;
});

describe('newsroom gates', () => {
	it('queues gates, applies default actions, and writes a gate.queued event', () => {
		const repo = createRepository();
		const gate = repo.queueGate({
			workspace_id: 'workspace-gates',
			story_id: 'story-gates',
			type: 'crawl_plan',
			title: 'Review crawl plan',
			summary: 'Approve the generated crawl plan before the monitor uses it.',
			payload: { seed_url: 'https://example.com' },
			priority: 2,
			created_by: 'monitor'
		});

		expect(gate).toMatchObject({
			workspace_id: 'workspace-gates',
			story_id: 'story-gates',
			type: 'crawl_plan',
			title: 'Review crawl plan',
			status: 'open',
			priority: 2,
			actions: ['approve', 'edit', 'reject'],
			resolution: null
		});
		expect(repo.listGates({ workspaceId: 'workspace-gates' }).map((candidate) => candidate.id)).toEqual([
			gate.id
		]);
		expect(repo.listEvents({ workspaceId: 'workspace-gates', storyId: 'story-gates' }).map((event) => event.kind)).toEqual([
			'gate.queued'
		]);
	});

	it('resolves a gate with editor action and notes and writes a gate.resolved event', () => {
		const repo = createRepository();
		const gate = repo.queueGate({
			workspace_id: 'workspace-gates',
			story_id: 'story-gates',
			type: 'pitch',
			title: 'Review pitch',
			summary: 'Decide whether this pitch should become a story workspace.',
			actions: ['accept', 'hold', 'spike']
		});

		const result = repo.resolveGate(gate.id, {
			action: 'accept',
			notes: 'Assign this for drafting.',
			actor: 'editor',
			payload: { workspace_seeded: true }
		});

		expect(result.gate).toMatchObject({
			id: gate.id,
			status: 'resolved',
			resolution: {
				action: 'accept',
				notes: 'Assign this for drafting.',
				payload: { workspace_seeded: true },
				actor: 'editor',
				event_id: result.event.id
			}
		});
		expect(result.event).toMatchObject({
			workspace_id: 'workspace-gates',
			story_id: 'story-gates',
			agent: 'editor',
			kind: 'gate.resolved',
			payload: {
				gate_id: gate.id,
				gate_type: 'pitch',
				action: 'accept',
				notes: 'Assign this for drafting.'
			}
		});
		expect(repo.listGates({ workspaceId: 'workspace-gates' })).toEqual([]);
		expect(repo.listGates({ workspaceId: 'workspace-gates', status: 'resolved' }).map((candidate) => candidate.id)).toEqual([
			gate.id
		]);
	});

	it('rejects unsupported actions and double resolution', () => {
		const repo = createRepository();
		const gate = repo.queueGate({
			workspace_id: 'workspace-gates',
			type: 'budget',
			title: 'Budget review',
			summary: 'Decide whether this overage can continue.',
			actions: ['approve_overage', 'pause']
		});

		expect(() => repo.resolveGate(gate.id, { action: 'publish' })).toThrow(/Unsupported gate action/);
		repo.resolveGate(gate.id, { action: 'pause' });
		expect(() => repo.resolveGate(gate.id, { action: 'pause' })).toThrow(/already resolved/);
	});

	it('supports every first-class newsroom gate type with usable actions', () => {
		const repo = createRepository();
		const types = [
			'pitch',
			'verification',
			'draft_review',
			'legal_style',
			'publish',
			'crawl_plan',
			'source_health',
			'budget'
		] as const;

		for (const type of types) {
			const gate = repo.queueGate({
				workspace_id: 'workspace-gates',
				type,
				title: `${type} gate`,
				summary: `Resolve the ${type} gate.`
			});
			expect(gate.actions.length).toBeGreaterThan(1);
		}

		expect(repo.listGates({ workspaceId: 'workspace-gates', limit: 20 })).toHaveLength(types.length);
	});

	it('writes verification gate resolutions back into the fact ledger', () => {
		const repo = createRepository();
		const gate = repo.queueGate({
			workspace_id: 'workspace-gates',
			story_id: 'story-gates',
			type: 'verification',
			title: 'Verify claim',
			summary: 'Resolve the claim status.',
			payload: {
				id: 'claim-resolution',
				claim: 'Council approved the shuttle plan.',
				sources: [{ title: 'Council minutes', url: 'https://sources.example/minutes' }],
				source_count: 1,
				two_source_rule: { required: 2, actual: 1, passed: false }
			}
		});

		repo.resolveGate(gate.id, {
			action: 'mark_verified',
			notes: 'Editor confirmed with a second source.'
		});

		expect(repo.inspectStoryMemory('story-gates', 'workspace-gates').current.fact_ledger).toEqual([
			expect.objectContaining({
				id: 'claim-resolution',
				status: 'verified',
				resolved_from_gate_id: gate.id
			})
		]);
		expect(repo.listEvents({ workspaceId: 'workspace-gates', storyId: 'story-gates' }).map((event) => event.kind)).toEqual([
			'gate.queued',
			'gate.resolved',
			'claim.verified'
		]);
	});

	it('writes source-health gate resolutions into source memory', () => {
		const repo = createRepository();
		const gate = repo.queueGate({
			workspace_id: 'workspace-gates',
			type: 'source_health',
			title: 'Review source health',
			summary: 'Source exceeded the failure budget.',
			payload: {
				url: 'https://example.com/flaky',
				host: 'example.com',
				reason: 'HTTP 503'
			}
		});

		repo.resolveGate(gate.id, {
			action: 'pause',
			notes: 'Pause until the feed recovers.'
		});

		expect(repo.inspectBeatMemory('source:example.com').current.source_quality).toEqual([
			expect.objectContaining({
				gate_id: gate.id,
				url: 'https://example.com/flaky',
				host: 'example.com',
				action: 'pause',
				status: 'paused',
				blocks_fetch: true
			})
		]);
		expect(repo.sourceHealthDecisionForUrl('https://example.com/flaky', 'workspace-gates')).toMatchObject({
			host: 'example.com',
			action: 'pause',
			status: 'paused',
			blocks_fetch: true,
			gate_id: gate.id
		});
	});
});

function createRepository(): HarnessRepository {
	db = openDatabase(':memory:');
	repository = new HarnessRepository(db);
	return repository;
}
