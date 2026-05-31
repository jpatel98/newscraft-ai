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
	it('keeps story memory as an append-only inspectable log', () => {
		const repo = createRepository();
		const handle = requireDb();

		const memoryEntry = repo.appendStoryMemory('story-1', {
			workspaceId: 'workspace-1',
			key: 'fact_ledger',
			value: { claim: 'Board requested an operational review', status: 'verified' },
			actor: 'research',
			createdAt: '2026-05-24T10:02:00.000Z'
		});
			repo.appendEvent({
				workspaceId: 'workspace-1',
				storyId: 'story-1',
				agent: 'research',
				kind: 'claim.verified',
				payload: { claim_id: 'claim-1' },
				createdAt: '2026-05-24T10:03:00.000Z'
			});

			const story = repo.inspectStoryMemory('story-1', 'workspace-1');

			expect(story.required_keys).toEqual(['fact_ledger', 'agent_event_log']);
			expect(story.current.fact_ledger).toEqual([
				{ claim: 'Board requested an operational review', status: 'verified' }
			]);
			expect(story.agent_event_log?.map((event) => event.kind)).toEqual(['claim.verified']);
			expect(() =>
				handle.prepare('UPDATE memory_entries SET kind = ? WHERE id = ?').run('changed', memoryEntry.id)
			).toThrow(/memory entries are append-only/);
			expect(() => handle.prepare('DELETE FROM memory_entries WHERE id = ?').run(memoryEntry.id)).toThrow(
				/memory entries are append-only/
			);
	});

	it('rejects unsupported scoped memory keys', () => {
		const repo = createRepository();

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
