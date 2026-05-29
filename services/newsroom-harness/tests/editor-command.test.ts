import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEditorCommand } from '../src/agents/editor-command.js';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';
import { resetPoliteFetchStateForTests } from '../src/tools/polite-fetch.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	resetPoliteFetchStateForTests();
	vi.unstubAllGlobals();
	repository?.close();
	repository = null;
	db = null;
});

describe('editor command routing', () => {
	it('routes URL commands to Monitor and records an ad-hoc scrape event with provenance', async () => {
		const repo = createRepository();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
				return new Response(
					[
						'<html><head><title>Water repairs approved</title></head>',
						'<body><article><p>Council approved urgent water system repairs after engineers found several valves were near failure.</p>',
						'<p>The project will begin next month and remain within the existing capital budget.</p></article></body></html>'
					].join(''),
					{ status: 200, headers: { 'content-type': 'text/html' } }
				);
			})
		);

		const result = await runEditorCommand(repo, {
			command: 'read this: https://city.example/water-repairs',
			workspaceId: 'workspace-command'
		});
		const events = repo.listEvents({ workspaceId: 'workspace-command' });

		expect(result).toMatchObject({
			ok: true,
			status: 'completed',
			handled_by: 'Monitor',
			agent: 'beat_monitor',
			source: {
				url: 'https://city.example/water-repairs',
				title: 'Water repairs approved',
				adapter: 'html_article'
			}
		});
		expect(events.map((event) => event.kind)).toEqual(['editor.command.routed', 'source.ad_hoc_scraped']);
		expect(events[1]).toMatchObject({
			agent: 'beat_monitor',
			parent_event_id: events[0]?.id,
			payload: expect.objectContaining({
				adapter: 'html_article',
				content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
				status_code: 200
			}),
			sources: [
				expect.objectContaining({
					url: 'https://city.example/water-repairs',
					adapter: 'html_article',
					content_hash: expect.stringMatching(/^[a-f0-9]{64}$/)
				})
			]
		});
	});

	it('routes story-context draft commands to Drafting and produces a draft review gate', async () => {
		const repo = createRepository();
		const storyId = 'story-command-draft';
		const workspaceId = 'workspace-command';
		for (const fact of verifiedFacts()) {
			repo.appendStoryMemory(storyId, {
				workspaceId,
				key: 'fact_ledger',
				kind: 'claim.verified',
				actor: 'verification',
				value: fact
			});
		}

		const result = await runEditorCommand(repo, {
			command: 'Draft a 300-word web story from this lead.',
			workspaceId,
			storyId
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'completed',
			handled_by: 'Drafting',
			agent: 'drafting',
			draft: {
				format: 'web_story_300'
			},
			gate: {
				type: 'draft_review',
				status: 'open'
			}
		});
		expect(repo.listEvents({ workspaceId, storyId }).map((event) => event.kind)).toEqual([
			'editor.command.routed',
			'draft.produced',
			'gate.queued'
		]);
	});

	it('keeps monitor lead commands on Monitor even when a story workspace is selected', async () => {
		const repo = createRepository();

		const result = await runEditorCommand(repo, {
			command: 'Find story leads for today.',
			workspaceId: 'workspace-command',
			storyId: 'story-active'
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'completed',
			handled_by: 'Monitor',
			agent: 'beat_monitor'
		});
		expect(repo.listEvents({ workspaceId: 'workspace-command', storyId: 'story-active' }).map((event) => event.kind)).toEqual([
			'editor.command.routed',
			'monitor.command.noted'
		]);
	});

	it('seeds client fact context before drafting from an overview workspace', async () => {
		const repo = createRepository();
		const workspaceId = 'story-post-1';

		const result = await runEditorCommand(repo, {
			command: 'Draft a 300-word web story from this lead.',
			workspaceId,
			storyId: workspaceId,
			facts: [
				{
					id: 'overview-angle',
					claim: 'Council approved overnight transit shuttles while the downtown rail tunnel is closed for repairs.',
					status: 'verified',
					sources: [
						{
							title: 'Transit agency briefing',
							name: 'Transit agency',
							url: 'https://sources.example/transit-briefing',
							content_hash: 'hash-overview'
						}
					]
				}
			]
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'completed',
			handled_by: 'Drafting',
			agent: 'drafting',
			draft: {
				format: 'web_story_300'
			}
		});
		expect(repo.inspectStoryMemory(workspaceId, workspaceId).current.fact_ledger).toEqual([
			expect.objectContaining({
				id: 'overview-angle',
				status: 'verified'
			})
		]);
	});

	it('records a blocked Drafting event when no active story workspace is available', () => {
		const repo = createRepository();

		const result = runEditorCommand(repo, {
			command: 'Draft a short story.',
			workspaceId: 'workspace-command'
		});

		return expect(result).resolves.toMatchObject({
			ok: false,
			status: 'blocked',
			handled_by: 'Drafting',
			error: 'Drafting needs an active story workspace.'
		});
	});
});

function createRepository(): HarnessRepository {
	db = openDatabase(':memory:');
	repository = new HarnessRepository(db);
	return repository;
}

function verifiedFacts() {
	return [
		'Council approved a temporary overnight shuttle network while crews repair the downtown rail tunnel through the summer period',
		'The approved plan adds buses every fifteen minutes on two routes that normally stop running shortly after midnight',
		'Agency staff said the tunnel work is needed because water damage has accelerated corrosion around electrical cabinets and signal equipment',
		'The transportation department expects the shuttle network to cost about two million dollars over the first twelve weeks',
		'Council members asked staff to publish weekly ridership updates so riders can see whether crowding worsens during repairs',
		'The agency said riders with accessibility needs will be able to request taxis when replacement buses cannot serve a stop',
		'Business groups near the closed stations asked the city for signs directing late-night customers to temporary bus stops',
		'The first closure begins June tenth, with a public briefing and route maps one week earlier'
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
