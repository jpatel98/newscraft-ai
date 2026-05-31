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

describe('newsroom memory stores', () => {
	it('updates and inspects the supported house memory keys', () => {
		const repo = createRepository();

		const memory = repo.updateHouseMemory(
			{
				style_guide: 'Prefer direct, attributed language.',
				banned_phrases: ['shocking twist'],
				libel_patterns: ['unsupported criminal accusation'],
				gazetteer: { Toronto: { province: 'Ontario', country: 'Canada' } },
				model_preferences: { drafting: 'fast', verification: 'careful' },
				beats: ['city hall', 'transit']
			},
			'editor'
		);

		expect(memory.required_keys).toEqual([
			'style_guide',
			'banned_phrases',
			'libel_patterns',
			'gazetteer',
			'model_preferences',
			'beats'
		]);
		expect(memory.current.style_guide).toBe('Prefer direct, attributed language.');
		expect(memory.current.banned_phrases).toEqual(['shocking twist']);
		expect(memory.current.gazetteer).toEqual({ Toronto: { province: 'Ontario', country: 'Canada' } });
		expect(memory.entries.map((entry) => entry.key)).toEqual([
			'style_guide',
			'banned_phrases',
			'libel_patterns',
			'gazetteer',
			'model_preferences',
			'beats'
		]);
	});

	it('keeps beat and story memory as append-only inspectable logs', () => {
		const repo = createRepository();
		const handle = requireDb();

		const sourceQuality = repo.appendBeatMemory('transit', {
			key: 'source_quality',
			value: { source: 'Transit agency RSS', reliability: 'primary' },
			actor: 'beat_monitor',
			createdAt: '2026-05-24T10:00:00.000Z'
		});
		repo.appendBeatMemory('transit', {
			key: 'editor_accept_patterns',
			value: { pattern: 'Accepts service-impact angles with primary docs' },
			actor: 'assignment_desk',
			createdAt: '2026-05-24T10:01:00.000Z'
		});
		repo.appendStoryMemory('story-1', {
			workspaceId: 'workspace-1',
			key: 'fact_ledger',
			value: { claim: 'Board requested an operational review', status: 'verified' },
			actor: 'research',
			createdAt: '2026-05-24T10:02:00.000Z'
		});
		repo.appendEvent({
			workspaceId: 'workspace-1',
			storyId: 'story-1',
			agent: 'verification',
			kind: 'claim.verified',
			payload: { claim_id: 'claim-1' },
			createdAt: '2026-05-24T10:03:00.000Z'
		});

		const beat = repo.inspectBeatMemory('transit');
		const story = repo.inspectStoryMemory('story-1', 'workspace-1');

		expect(beat.required_keys).toEqual([
			'crawl_plans',
			'source_quality',
			'prior_coverage',
			'peer_coverage',
			'editor_accept_patterns',
			'editor_spike_patterns'
		]);
		expect(beat.current.source_quality).toEqual([
			{ source: 'Transit agency RSS', reliability: 'primary' }
		]);
		expect(story.required_keys).toEqual([
			'fact_ledger',
			'draft_history',
			'package_history',
			'delivery_history',
			'agent_event_log',
			'editor_decisions'
		]);
		expect(story.current.fact_ledger).toEqual([
			{ claim: 'Board requested an operational review', status: 'verified' }
		]);
		expect(story.agent_event_log?.map((event) => event.kind)).toEqual(['claim.verified']);
		expect(() =>
			handle.prepare('UPDATE memory_entries SET kind = ? WHERE id = ?').run('changed', sourceQuality.id)
		).toThrow(/memory entries are append-only/);
		expect(() => handle.prepare('DELETE FROM memory_entries WHERE id = ?').run(sourceQuality.id)).toThrow(
			/memory entries are append-only/
		);
	});

	it('rejects unsupported scoped memory keys', () => {
		const repo = createRepository();

		expect(() =>
			repo.appendBeatMemory('transit', { key: 'random_notes', value: 'nope' })
		).toThrow(/Unsupported beat memory key/);
		expect(() =>
			repo.appendStoryMemory('story-1', { key: 'random_notes', value: 'nope' })
		).toThrow(/Unsupported story memory key/);
	});

	it('scopes story memory entries to the requested workspace', () => {
		const repo = createRepository();
		repo.appendStoryMemory('story-shared', {
			workspaceId: 'workspace-a',
			key: 'fact_ledger',
			value: { claim: 'Workspace A verified this claim', status: 'verified' }
		});
		repo.appendStoryMemory('story-shared', {
			workspaceId: 'workspace-b',
			key: 'fact_ledger',
			value: { claim: 'Workspace B verified a different claim', status: 'verified' }
		});

		expect(repo.inspectStoryMemory('story-shared', 'workspace-a').current.fact_ledger).toEqual([
			{ claim: 'Workspace A verified this claim', status: 'verified' }
		]);
		expect(repo.inspectStoryMemory('story-shared', 'workspace-b').current.fact_ledger).toEqual([
			{ claim: 'Workspace B verified a different claim', status: 'verified' }
		]);
	});
});

function createRepository(): HarnessRepository {
	db = openDatabase(':memory:');
	repository = new HarnessRepository(db);
	return repository;
}

function requireDb(): HarnessDb {
	if (!db) throw new Error('test database is not open');
	return db;
}
