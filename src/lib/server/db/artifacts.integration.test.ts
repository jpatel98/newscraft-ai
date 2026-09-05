import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ensureMigrated, sql } from './index';
import { createConversation, addMessage } from './conversations';
import {
	claimHermesRunLease,
	createOrGetHermesRun,
	finalizeHermesRunCancellation,
	getHermesRun,
	requestHermesRunCancellation,
	releaseHermesRunLease
} from './hermes-runs';
import {
	attachArtifactReferencesToEvent,
	createArtifactRevision,
	createArtifactRevisionForRun,
	createArtifactUploadGrant,
	finalizeArtifactReady,
	getArtifactDetail,
	markArtifactGrantUploadedForToken
} from './artifacts';
import { createLocalArtifactStorage, verifyArtifactObject } from '$lib/server/artifacts/storage';

const databaseUrl = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';

// A real 1x1 PNG keeps these tests on the same verifier path as the Hermes
// publisher without seeding an artifact row or bypassing object verification.
const PNG_BYTES = new Uint8Array(Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64'
));

describe.skipIf(!databaseUrl)('artifact repository and durable-run integration', () => {
	const accountId = `artifact-test-${Date.now()}`;
	const createdObjects: Array<{ key: string; version: string }> = [];
	const storage = createLocalArtifactStorage();

	beforeAll(async () => {
		await ensureMigrated();
		const now = Date.now();
		await sql`
			INSERT INTO accounts (id, email, name, role, created_at, updated_at)
			VALUES (${accountId}, ${`${accountId}@example.test`}, 'Artifact integration', 'member', ${now}, ${now})
		`;
	});

	afterAll(async () => {
		for (const object of createdObjects) await storage.remove(object.key, object.version);
		await sql`DELETE FROM accounts WHERE id = ${accountId}`;
		await sql.end({ timeout: 1 });
	});

	async function createRun(label: string) {
		const conversation = await createConversation(accountId);
		const user = await addMessage({ conversationId: conversation.id, role: 'user', content: `Publish ${label}.` });
		const assistant = await addMessage({ conversationId: conversation.id, role: 'assistant', content: '', partial: true });
		const result = await createOrGetHermesRun({
			accountId,
			orgId: conversation.orgId,
			conversationId: conversation.id,
			userMessageId: user.id,
			assistantMessageId: assistant.id,
			idempotencyKey: `${label}-${conversation.id}`,
			tenantKey: `tenant-${accountId}`,
			sessionId: `session-${conversation.id}`,
			inputJson: JSON.stringify({ messages: [{ role: 'user', content: `Publish ${label}.` }] }),
			seededCitationsJson: '[]'
		});
		const claimed = await claimHermesRunLease(accountId, result.run.id, `worker-${label}`);
		if (!claimed?.leaseOwner || !claimed.leaseToken) throw new Error('test run was not leased');
		return { conversation, user, assistant, run: claimed };
	}

	function lease(run: { id: string; tenantKey: string; leaseOwner: string | null; leaseToken: string | null }) {
		if (!run.leaseOwner || !run.leaseToken) throw new Error('test lease is missing');
		return { runId: run.id, tenantKey: run.tenantKey, leaseOwner: run.leaseOwner, leaseToken: run.leaseToken };
	}

	function imageSpec(title: string) {
		return { kind: 'image' as const, title, alt: `${title} preview` };
	}

	async function createImageGrant(runData: Awaited<ReturnType<typeof createRun>>, label: string) {
		const created = await createArtifactRevisionForRun({
			accountId,
			runId: runData.run.id,
			tenantKey: runData.run.tenantKey,
			leaseOwner: runData.run.leaseOwner!,
			leaseToken: runData.run.leaseToken!,
			spec: imageSpec(label)
		});
		const grantResult = await createArtifactUploadGrant({
			accountId,
			revisionId: created.revision.id,
			runId: runData.run.id,
			lease: lease(runData.run),
			role: 'source',
			producerKey: 'hermes-publish-artifact',
			allowedMime: 'image/png',
			maxBytes: PNG_BYTES.byteLength,
			exactBytes: PNG_BYTES.byteLength,
			expectedSha256: createHash('sha256').update(PNG_BYTES).digest('hex')
		});
		const stored = await storage.putStaged(grantResult.grant.stagingKey, PNG_BYTES, 'image/png');
		createdObjects.push({ key: stored.key, version: stored.version });
		const accepted = await markArtifactGrantUploadedForToken(
			grantResult.grant.id,
			grantResult.token,
			grantResult.grant.stagingKey,
			stored.version
		);
		expect(accepted).toBe(true);
		const verified = await verifyArtifactObject(storage, {
			key: grantResult.grant.stagingKey,
			version: stored.version,
			allowedMime: 'image/png',
			maxBytes: grantResult.grant.maxBytes,
			exactBytes: grantResult.grant.exactBytes,
			expectedSha256: grantResult.grant.expectedSha256,
			role: 'source'
		});
		return { revision: created.revision, grant: grantResult.grant, token: grantResult.token, verified };
	}

	it('rejects finalization after cancellation during object verification', async () => {
		const runData = await createRun('cancel-during-verify');
		const publication = await createImageGrant(runData, 'cancelled image');
		await requestHermesRunCancellation(accountId, runData.run.id, 'integration test');

		await expect(finalizeArtifactReady({
			accountId,
			grantId: publication.grant.id,
			objectKey: publication.grant.stagingKey,
			objectVersion: publication.verified.version,
			verified: publication.verified,
			lease: lease(runData.run)
		})).rejects.toMatchObject({ code: 'stale' });
		const cancelled = await finalizeHermesRunCancellation(accountId, runData.run.id, 'integration test');
		expect(cancelled.state).toBe('cancelled');
	});

	it('rejects the old owner after lease turnover and accepts the new owner', async () => {
		const runData = await createRun('lease-turnover');
		const publication = await createImageGrant(runData, 'lease image');
		const oldLease = lease(runData.run);
		await releaseHermesRunLease(accountId, runData.run.id, oldLease.leaseOwner, oldLease.leaseToken);
		const renewed = await claimHermesRunLease(accountId, runData.run.id, 'worker-lease-turnover-new');
		if (!renewed) throw new Error('test run could not be reclaimed');

		await expect(finalizeArtifactReady({
			accountId,
			grantId: publication.grant.id,
			objectKey: publication.grant.stagingKey,
			objectVersion: publication.verified.version,
			verified: publication.verified,
			lease: oldLease
		})).rejects.toMatchObject({ code: 'stale' });
		const summary = await finalizeArtifactReady({
			accountId,
			grantId: publication.grant.id,
			objectKey: publication.grant.stagingKey,
			objectVersion: publication.verified.version,
			verified: publication.verified,
			lease: lease(renewed)
		});
		expect(summary.status).toBe('ready');
	});

	it('converges duplicate finalization and records one ready-event reference', async () => {
		const runData = await createRun('duplicate-finalize');
		const publication = await createImageGrant(runData, 'duplicate image');
		const first = await finalizeArtifactReady({
			accountId,
			grantId: publication.grant.id,
			objectKey: publication.grant.stagingKey,
			objectVersion: publication.verified.version,
			verified: publication.verified,
			lease: lease(runData.run)
		});
		const second = await finalizeArtifactReady({
			accountId,
			grantId: publication.grant.id,
			objectKey: publication.grant.stagingKey,
			objectVersion: publication.verified.version,
			verified: publication.verified,
			lease: lease(runData.run)
		});
		expect(second).toMatchObject({ id: first.id, revisionId: first.revisionId, status: 'ready' });

		const runBeforeEvent = await getHermesRun(accountId, runData.run.id);
		if (!runBeforeEvent) throw new Error('test run disappeared');
		const cursor = runBeforeEvent.cursor + 1;
		const { appendHermesRunEvent } = await import('./hermes-runs');
		await appendHermesRunEvent(accountId, runData.run.id, runData.run.leaseOwner!, runData.run.leaseToken!, {
			eventType: 'artifact.ready',
			dataJson: JSON.stringify({ artifact_revision_id: publication.revision.id, artifact: first }),
			workerCursor: runBeforeEvent.workerCursor + 1,
			artifactRevisionId: publication.revision.id
		});
		await attachArtifactReferencesToEvent(accountId, runData.run.id, publication.revision.id, cursor);
		const refs = await sql`
			SELECT run_id, revision_id, cursor FROM hermes_run_artifact_refs
			WHERE run_id = ${runData.run.id} AND revision_id = ${publication.revision.id}
		`;
		expect(refs).toHaveLength(1);
		expect(refs[0].cursor).toBe(cursor);
		const detail = await getArtifactDetail(accountId, runData.conversation.id, first.id, first.revisionId);
		expect(detail?.assets).toHaveLength(1);
	});

	it('refreshes an upload grant without allowing the old token generation to attach', async () => {
		const runData = await createRun('grant-refresh');
		const publication = await createImageGrant(runData, 'refresh image');
		const refreshed = await createArtifactUploadGrant({
			accountId,
			revisionId: publication.revision.id,
			runId: runData.run.id,
			lease: lease(runData.run),
			role: 'source',
			producerKey: 'hermes-publish-artifact',
			allowedMime: 'image/png',
			maxBytes: PNG_BYTES.byteLength,
			exactBytes: PNG_BYTES.byteLength,
			expectedSha256: createHash('sha256').update(PNG_BYTES).digest('hex')
		});
		expect(refreshed.grant.id).toBe(publication.grant.id);
		expect(refreshed.grant.stagingKey).not.toBe(publication.grant.stagingKey);
		expect(await markArtifactGrantUploadedForToken(
			publication.grant.id,
			publication.token,
			publication.grant.stagingKey,
			publication.verified.version
		)).toBe(false);
	});

	it('keeps a newer family revision authoritative when an older upload finishes later', async () => {
		const runData = await createRun('revision-order');
		const first = await createArtifactRevision({
			accountId,
			conversationId: runData.conversation.id,
			sourceMessageId: runData.assistant.id,
			kind: 'image',
			title: 'revision one',
			spec: imageSpec('revision one')
		});
		const second = await createArtifactRevision({
			accountId,
			conversationId: runData.conversation.id,
			sourceMessageId: runData.assistant.id,
			kind: 'image',
			title: 'revision two',
			spec: imageSpec('revision two'),
			familyId: first.family.id,
			baseRevisionId: first.revision.id
		});

		async function grantFor(revisionId: string) {
			const result = await createArtifactUploadGrant({
				accountId,
				revisionId,
				runId: runData.run.id,
				lease: lease(runData.run),
				role: 'source',
				producerKey: `hermes-publish-artifact-${revisionId}`,
				allowedMime: 'image/png',
				maxBytes: PNG_BYTES.byteLength,
				exactBytes: PNG_BYTES.byteLength,
				expectedSha256: createHash('sha256').update(PNG_BYTES).digest('hex')
			});
			const object = await storage.putStaged(result.grant.stagingKey, PNG_BYTES, 'image/png');
			createdObjects.push({ key: object.key, version: object.version });
			await markArtifactGrantUploadedForToken(result.grant.id, result.token, result.grant.stagingKey, object.version);
			const verified = await verifyArtifactObject(storage, {
				key: result.grant.stagingKey,
				version: object.version,
				allowedMime: 'image/png',
				maxBytes: result.grant.maxBytes,
				exactBytes: result.grant.exactBytes,
				expectedSha256: result.grant.expectedSha256,
				role: 'source'
			});
			return { grant: result.grant, verified };
		}

		const oldUpload = await grantFor(first.revision.id);
		const newUpload = await grantFor(second.revision.id);
		await finalizeArtifactReady({ accountId, grantId: newUpload.grant.id, objectKey: newUpload.grant.stagingKey, objectVersion: newUpload.verified.version, verified: newUpload.verified, lease: lease(runData.run) });
		await finalizeArtifactReady({ accountId, grantId: oldUpload.grant.id, objectKey: oldUpload.grant.stagingKey, objectVersion: oldUpload.verified.version, verified: oldUpload.verified, lease: lease(runData.run) });
		const detail = await getArtifactDetail(accountId, runData.conversation.id, first.family.id);
		expect(detail?.revisionId).toBe(second.revision.id);
	});

	it('rejects a grant that crosses the durable run conversation boundary', async () => {
		const firstRun = await createRun('cross-conversation-a');
		const secondRun = await createRun('cross-conversation-b');
		const foreign = await createArtifactRevision({
			accountId,
			conversationId: secondRun.conversation.id,
			sourceMessageId: secondRun.assistant.id,
			kind: 'image',
			title: 'foreign revision',
			spec: imageSpec('foreign revision')
		});

		await expect(createArtifactUploadGrant({
			accountId,
			revisionId: foreign.revision.id,
			runId: firstRun.run.id,
			lease: lease(firstRun.run),
			role: 'source',
			producerKey: 'hermes-publish-artifact-cross-conversation',
			allowedMime: 'image/png',
			maxBytes: PNG_BYTES.byteLength,
			exactBytes: PNG_BYTES.byteLength,
			expectedSha256: createHash('sha256').update(PNG_BYTES).digest('hex')
		})).rejects.toMatchObject({ code: 'conflict' });

		const run = await getHermesRun(accountId, firstRun.run.id);
		expect(run?.conversationId).toBe(firstRun.conversation.id);
	});

});
