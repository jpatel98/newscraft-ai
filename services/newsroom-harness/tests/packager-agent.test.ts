import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { deliverPackage } from '../src/agents/delivery.js';
import { runDraftingAgent } from '../src/agents/drafting.js';
import { runPackagerAgent } from '../src/agents/packager.js';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;
let fixtures: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
	repository?.close();
	repository = null;
	db = null;
	await Promise.all(fixtures.map((fixture) => fixture.close()));
	fixtures = [];
});

describe('packager agent and delivery', () => {
	it('turns an approved draft into newsroom package outputs and queues a publish gate', () => {
		const repo = createRepository();
		const { storyId, workspaceId } = seedApprovedDraft(repo);

		const result = runPackagerAgent(repo, { storyId, workspaceId });
		const story = repo.inspectStoryMemory(storyId, workspaceId);

		expect(result.package.outputs.brief.word_count).toBeGreaterThanOrEqual(45);
		expect(result.package.outputs.web_story.markdown).toContain('[1]');
		expect(result.package.outputs.feature.word_count).toBeGreaterThanOrEqual(700);
		expect(result.package.outputs.broadcast_script.markdown).toContain('ANCHOR INTRO');
		expect(result.package.outputs.social_pack.x).toContain(result.package.headline);
		expect(result.package.outputs.push.title).toBeTruthy();
		expect(result.package.outputs.newsletter_blurb.subject).toBeTruthy();
		expect(result.package.outputs.headline_pack.general).toHaveLength(5);
		expect(result.package.outputs.headline_pack.seo.headline).toBeTruthy();
		expect(result.package.outputs.headline_pack.social.rationale).toMatch(/source-backed/i);
		expect(result.gate).toMatchObject({
			workspace_id: workspaceId,
			story_id: storyId,
			type: 'publish',
			status: 'open',
			created_by: 'packager',
			actions: ['approve', 'hold', 'send_to_cms']
		});
		expect(story.current.package_history).toEqual([
			expect.objectContaining({
				package_id: result.package.package_id,
				draft_event_id: result.package.draft_event_id,
				outputs: expect.objectContaining({
					headline_pack: expect.any(Object)
				})
			})
		]);
		expect(repo.listEvents({ workspaceId, storyId }).map((event) => event.kind)).toContain('package.produced');
	});

	it('requires an approved draft review gate before packaging', () => {
		const repo = createRepository();
		const storyId = 'story-package-unapproved';
		const workspaceId = 'workspace-package';
		for (const fact of verifiedFacts()) {
			repo.appendStoryMemory(storyId, {
				workspaceId,
				key: 'fact_ledger',
				kind: 'claim.verified',
				actor: 'verification',
				value: fact
			});
		}
		runDraftingAgent(repo, { storyId, workspaceId });

		expect(() => runPackagerAgent(repo, { storyId, workspaceId })).toThrow(/approved draft review gate/);
		expect(repo.listGates({ workspaceId, storyId }).filter((gate) => gate.type === 'publish')).toHaveLength(0);
	});

	it('fails closed before the publish gate is resolved and logs delivery attempts', async () => {
		const repo = createRepository();
		const { storyId, workspaceId } = seedApprovedDraft(repo);
		const packaged = runPackagerAgent(repo, { storyId, workspaceId });
		const fixture = await startDeliveryFixture();
		fixtures.push(fixture);

		const blocked = await deliverPackage(repo, loadConfig(), {
			storyId,
			workspaceId,
			packageId: packaged.package.package_id,
			channel: 'webhook',
			targetUrl: fixture.url
		});
		expect(blocked).toMatchObject({
			ok: false,
			status: 'failed',
			channel: 'webhook',
			response_status: null
		});
		expect(fixture.received).toHaveLength(0);

		repo.resolveGate(packaged.gate.id, { action: 'approve', actor: 'editor' });
		const preparedEmail = await deliverPackage(repo, loadConfig(), {
			storyId,
			workspaceId,
			packageId: packaged.package.package_id,
			channel: 'email_digest'
		});
		const webhook = await deliverPackage(repo, loadConfig(), {
			storyId,
			workspaceId,
			packageId: packaged.package.package_id,
			channel: 'webhook',
			targetUrl: `${fixture.url}/webhook`
		});
		const slack = await deliverPackage(repo, loadConfig(), {
			storyId,
			workspaceId,
			packageId: packaged.package.package_id,
			channel: 'slack',
			targetUrl: `${fixture.url}/slack`
		});

		expect(preparedEmail.status).toBe('prepared');
		expect(webhook).toMatchObject({ ok: true, status: 'sent', target_host: '127.0.0.1' });
		expect(slack).toMatchObject({ ok: true, status: 'sent', target_host: '127.0.0.1' });
		expect(fixture.received.map((request) => request.pathname)).toEqual(['/webhook', '/slack']);
		expect(fixture.received[0]?.body).toMatchObject({
			type: 'newscraft.package',
			package_id: packaged.package.package_id
		});
		expect(fixture.received[1]?.body).toMatchObject({
			blocks: expect.any(Array)
		});
		expect(repo.inspectStoryMemory(storyId, workspaceId).current.delivery_history).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: 'failed', channel: 'webhook' }),
				expect.objectContaining({ status: 'prepared', channel: 'email_digest' }),
				expect.objectContaining({ status: 'sent', channel: 'webhook' }),
				expect.objectContaining({ status: 'sent', channel: 'slack' })
			])
		);
	});

	it('pushes a WordPress REST draft without storing credentials in events or memory', async () => {
		const repo = createRepository();
		const { storyId, workspaceId } = seedApprovedDraft(repo);
		const packaged = runPackagerAgent(repo, { storyId, workspaceId });
		repo.resolveGate(packaged.gate.id, { action: 'send_to_cms', actor: 'editor' });
		const fixture = await startDeliveryFixture();
		fixtures.push(fixture);

		const result = await deliverPackage(
			repo,
			loadConfig({
				wordpressRestUrl: `${fixture.url}/wp-json`,
				wordpressUsername: 'editor',
				wordpressApplicationPassword: 'secret-app-password'
			}),
			{
				storyId,
				workspaceId,
				packageId: packaged.package.package_id,
				channel: 'wordpress'
			}
		);
		const memoryJson = JSON.stringify(repo.inspectStoryMemory(storyId, workspaceId));
		const eventsJson = JSON.stringify(repo.listEvents({ workspaceId, storyId }));

		expect(result).toMatchObject({ ok: true, status: 'sent', external_id: 'wp-post-1' });
		expect(fixture.received[0]).toMatchObject({
			pathname: '/wp-json/wp/v2/posts',
			authorization: expect.stringMatching(/^Basic /),
			body: expect.objectContaining({
				status: 'draft',
				meta: expect.objectContaining({ newscraft_package_id: packaged.package.package_id })
			})
		});
		expect(memoryJson).not.toContain('secret-app-password');
		expect(eventsJson).not.toContain('secret-app-password');
	});
});

function createRepository(): HarnessRepository {
	db = openDatabase(':memory:');
	repository = new HarnessRepository(db);
	return repository;
}

function seedApprovedDraft(repo: HarnessRepository): { storyId: string; workspaceId: string } {
	const storyId = 'story-package-1';
	const workspaceId = 'workspace-package';
	for (const fact of verifiedFacts()) {
		repo.appendStoryMemory(storyId, {
			workspaceId,
			key: 'fact_ledger',
			kind: 'claim.verified',
			actor: 'verification',
			value: fact
		});
	}
	const draft = runDraftingAgent(repo, { storyId, workspaceId, targetWordCount: 300 });
	repo.resolveGate(draft.gate.id, {
		action: 'approve',
		notes: 'Approved for packaging.',
		actor: 'editor'
	});
	return { storyId, workspaceId };
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
				archive_snapshot_url: `https://web.archive.org/web/20260529010000/https://sources.example/fact-${index + 1}`,
				content_hash: `hash-${index + 1}`
			}
		]
	}));
}

async function startDeliveryFixture(): Promise<{
	url: string;
	received: Array<{ pathname: string; authorization: string | null; body: any }>;
	close: () => Promise<void>;
}> {
	const received: Array<{ pathname: string; authorization: string | null; body: any }> = [];
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		const bodyText = Buffer.concat(chunks).toString('utf8');
		const body = bodyText ? JSON.parse(bodyText) : null;
		const url = new URL(req.url || '/', 'http://127.0.0.1');
		received.push({
			pathname: url.pathname,
			authorization: Array.isArray(req.headers.authorization) ? null : req.headers.authorization || null,
			body
		});
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ id: url.pathname.includes('/wp-json/') ? 'wp-post-1' : `delivery-${received.length}` }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('fixture server did not start');
	return {
		url: `http://127.0.0.1:${address.port}`,
		received,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			})
	};
}
