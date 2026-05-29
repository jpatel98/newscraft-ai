import { afterEach, describe, expect, it } from 'vitest';
import { runDraftingAgent } from '../src/agents/drafting.js';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	repository?.close();
	repository = null;
	db = null;
});

describe('drafting agent', () => {
	it('drafts a cited web story only from verified source-backed fact ledger entries', () => {
		const repo = createRepository();
		const storyId = 'story-draft-1';
		const workspaceId = 'account:editor-1';
		for (const fact of verifiedFacts()) {
			repo.appendStoryMemory(storyId, {
				key: 'fact_ledger',
				kind: 'claim.verified',
				actor: 'verification',
				value: fact
			});
		}
		repo.appendStoryMemory(storyId, {
			key: 'fact_ledger',
			kind: 'claim.disputed',
			actor: 'verification',
			value: {
				id: 'unsupported-disputed',
				claim: 'A rumour says the program has already been cancelled',
				status: 'disputed',
				sources: [{ title: 'Forum post', url: 'https://forum.example/rumour' }]
			}
		});
		repo.appendStoryMemory(storyId, {
			key: 'fact_ledger',
			kind: 'claim.verified',
			actor: 'verification',
			value: {
				id: 'unsupported-sourceless',
				claim: 'Officials privately expect a second announcement next month',
				status: 'verified'
			}
		});

		const result = runDraftingAgent(repo, { storyId, workspaceId, targetWordCount: 300 });
		const story = repo.inspectStoryMemory(storyId, workspaceId);
		const events = repo.listEvents({ workspaceId, storyId });

		expect(result.draft.format).toBe('web_story_300');
		expect(result.draft.word_count).toBeGreaterThanOrEqual(260);
		expect(result.draft.word_count).toBeLessThanOrEqual(340);
		expect(result.draft.markdown).toContain('[1]');
		expect(result.draft.markdown).toContain('[8]');
		expect(result.draft.markdown).not.toContain('rumour');
		expect(result.draft.markdown).not.toContain('privately expect');
		expect(result.draft.citations).toHaveLength(8);
		expect(result.draft.citations.every((citation) => citation.source_url.startsWith('https://sources.example/'))).toBe(true);
		expect(result.gate).toMatchObject({
			workspace_id: workspaceId,
			story_id: storyId,
			type: 'draft_review',
			status: 'open',
			created_by: 'drafting',
			actions: ['approve', 'return_with_notes', 'spike']
		});
		expect(story.current.draft_history).toEqual([
			expect.objectContaining({
				format: 'web_story_300',
				draft_markdown: result.draft.markdown,
				facts_used: result.draft.facts_used
			})
		]);
		expect(events.map((event) => event.kind)).toEqual(['draft.produced', 'gate.queued']);
	});

	it('refuses to draft when no verified source-backed facts exist', () => {
		const repo = createRepository();
		repo.appendStoryMemory('story-draft-2', {
			key: 'fact_ledger',
			value: {
				id: 'needs-more',
				claim: 'The agency may change the route map',
				status: 'needs_more',
				sources: [{ title: 'Agency note', url: 'https://sources.example/needs-more' }]
			}
		});

		expect(() => runDraftingAgent(repo, { storyId: 'story-draft-2', workspaceId: 'account:editor-1' })).toThrow(
			/verified, source-backed fact ledger entry/
		);
		expect(repo.listGates({ workspaceId: 'account:editor-1', storyId: 'story-draft-2' })).toHaveLength(0);
	});
});

function createRepository(): HarnessRepository {
	db = openDatabase(':memory:');
	repository = new HarnessRepository(db);
	return repository;
}

function verifiedFacts() {
	return [
		'The transit agency approved a temporary overnight shuttle network while crews repair the downtown rail tunnel through the summer period',
		'The approved plan adds buses every fifteen minutes on two routes that normally stop running shortly after midnight',
		'Agency staff said the tunnel work is needed because water damage has accelerated corrosion around electrical cabinets and signal equipment',
		'The city transportation department expects the shuttle network to cost about two million dollars over the first twelve weeks',
		'Council members asked staff to publish weekly ridership updates so riders can see whether crowding worsens during repairs',
		'The agency said riders with accessibility needs will be able to request taxis when replacement buses cannot serve a stop',
		'Business groups near the closed stations asked the city for signs directing late-night customers to temporary bus stops',
		'The first closure begins June tenth, with the agency planning a public briefing and route maps one week earlier'
	].map((claim, index) => ({
		id: `fact-${index + 1}`,
		claim,
		status: 'verified',
		sources: [
			{
				title: `Source document ${index + 1}`,
				name: `Transit agency source ${index + 1}`,
				url: `https://sources.example/fact-${index + 1}`,
				content_hash: `hash-${index + 1}`
			}
		]
	}));
}
