import { afterEach, describe, expect, it } from 'vitest';
import { runCopyAgent } from '../src/agents/copy.js';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	repository?.close();
	repository = null;
	db = null;
});

describe('copy agent', () => {
	it('runs a house-style pass and queues Legal/Style gates for high-risk copy', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-copy';
		const storyId = 'story-copy';
		repo.updateHouseMemory(
			{
				style_guide: 'Prefer restrained, attributed language. Avoid unsupported criminal accusations.',
				banned_phrases: ['shocking twist'],
				libel_patterns: ['unsupported criminal accusation']
			},
			'editor'
		);
		const draft = repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'drafting',
			kind: 'draft.produced',
			payload: {
				headline: 'Transit review raises questions',
				draft_markdown:
					'# Transit review raises questions\n\nThe report makes an unsupported criminal accusation in a shocking twist.'
			}
		});

		const result = runCopyAgent(repo, { workspaceId, storyId });

		expect(result).toMatchObject({
			ok: true,
			status: 'completed',
			risk: 'high',
			gate: {
				type: 'legal_style',
				status: 'open',
				actions: ['approve', 'edit', 'block']
			}
		});
		expect(result.findings.map((finding) => finding.code)).toEqual([
			'banned_phrase',
			'libel_pattern',
			'unattributed_legal_risk'
		]);
		expect(repo.listEvents({ workspaceId, storyId }).map((event) => event.kind)).toEqual([
			'draft.produced',
			'copy.reviewed',
			'gate.queued'
		]);
		expect(repo.listEvents({ workspaceId, storyId })[1]).toMatchObject({
			parent_event_id: draft.id,
			payload: expect.objectContaining({
				style_guide_applied: true,
				advisory: true
			})
		});
	});

	it('dedupes Legal/Style gates for repeated high-risk copy runs on the same draft', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-copy';
		const storyId = 'story-copy';
		repo.updateHouseMemory({ libel_patterns: ['unsupported criminal accusation'] }, 'editor');
		repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'drafting',
			kind: 'draft.produced',
			payload: {
				headline: 'Transit review raises questions',
				draft_markdown: 'The draft contains an unsupported criminal accusation.'
			}
		});

		const first = runCopyAgent(repo, { workspaceId, storyId });
		const second = runCopyAgent(repo, { workspaceId, storyId });

		expect(first.gate?.id).toBe(second.gate?.id);
		expect(repo.listGates({ workspaceId, storyId, status: 'open' })).toHaveLength(1);
		expect(repo.listEvents({ workspaceId, storyId }).filter((event) => event.kind === 'gate.queued')).toHaveLength(1);
	});

	it('checks legal attribution at the claim level instead of the whole draft', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-copy';
		const storyId = 'story-copy';
		repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'drafting',
			kind: 'draft.produced',
			payload: {
				headline: 'Legal risk draft',
				draft_markdown:
					'According to court records, the agency filed a lawsuit. The mayor accused the contractor of fraud.'
			}
		});

		const result = runCopyAgent(repo, { workspaceId, storyId });

		expect(result.findings).toEqual([
			expect.objectContaining({
				code: 'unattributed_legal_risk',
				match: 'accused, fraud'
			})
		]);
		expect(result.risk).toBe('high');
	});

	it('does not treat libel patterns as unbounded substrings', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-copy';
		const storyId = 'story-copy';
		repo.updateHouseMemory({ libel_patterns: ['con'] }, 'editor');
		repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'drafting',
			kind: 'draft.produced',
			payload: {
				headline: 'Construction update',
				draft_markdown: 'The city said concrete work will continue next week.'
			}
		});

		const result = runCopyAgent(repo, { workspaceId, storyId });

		expect(result.findings.map((finding) => finding.code)).toEqual(['clean_pass']);
		expect(result.risk).toBe('low');
		expect(result.gate).toBeUndefined();
	});

	it('selects the latest draft by timestamp rather than source array order', () => {
		const repo = createRepository();
		const workspaceId = 'workspace-copy';
		const storyId = 'story-copy';
		repo.updateHouseMemory({ libel_patterns: ['unsupported criminal accusation'] }, 'editor');
		repo.appendStoryMemory(storyId, {
			workspaceId,
			key: 'draft_history',
			kind: 'draft.produced',
			actor: 'drafting',
			createdAt: '2026-05-30T12:00:00.000Z',
			value: {
				headline: 'Newer clean draft',
				draft_markdown: 'The city said the review will continue next week.'
			}
		});
		repo.appendEvent({
			workspaceId,
			storyId,
			agent: 'drafting',
			kind: 'draft.produced',
			createdAt: '2026-05-30T10:00:00.000Z',
			payload: {
				headline: 'Older risky draft',
				draft_markdown: 'The draft contains an unsupported criminal accusation.'
			}
		});

		const result = runCopyAgent(repo, { workspaceId, storyId });

		expect(result.risk).toBe('low');
		expect(result.gate).toBeUndefined();
		expect(repo.listEvents({ workspaceId, storyId }).at(-1)?.payload).toMatchObject({
			headline: 'Newer clean draft'
		});
	});
});

function createRepository(): HarnessRepository {
	db = openDatabase(':memory:');
	repository = new HarnessRepository(db);
	return repository;
}
