import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, ensureMigrated } from './index';
import {
	claimForProcessing,
	completeTranscript,
	createTranscript,
	deleteTranscript,
	failTranscript,
	getTranscript,
	listTranscripts,
	publicTranscript,
	STALE_PROCESSING_MS,
	updateTranscript
} from './transcripts';

const url = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';
describe.skipIf(!url)('account-owned transcripts', () => {
	const a = `tx-a-${Date.now()}`;
	const b = `tx-b-${Date.now()}`;
	const base = { sourceKind: 'upload' as const, keyterms: ['TTC'], engine: 'elevenlabs', model: 'scribe_v2' };
	beforeAll(async () => {
		await ensureMigrated();
		for (const id of [a, b]) await sql`INSERT INTO accounts (id,email,name,role,created_at,updated_at) VALUES (${id},${id + '@example.test'},'Transcripts test','member',1,1)`;
	});
	afterAll(async () => {
		await sql`DELETE FROM accounts WHERE id IN (${a},${b})`;
		await sql.end({ timeout: 1 });
	});

	it('creates, claims once, completes, searches and edits for the owner only', async () => {
		const t = await createTranscript({ ...base, accountId: a, title: 'Council presser', sourceName: 'presser.m4a', contentType: 'audio/mp4', audioBytes: 10 });
		expect(t).toMatchObject({ status: 'uploading', audioKey: `${a}/${t.id}/audio`, keyterms: ['TTC'], hasAudio: false });
		expect(publicTranscript(t)).not.toHaveProperty('audioKey');
		expect(await getTranscript(b, t.id)).toBeNull();
		expect(await claimForProcessing(b, t.id)).toBeNull();

		const claimed = await claimForProcessing(a, t.id, { bytes: 1234, contentType: 'audio/mp4' });
		expect(claimed).toMatchObject({ status: 'processing' });
		expect(await claimForProcessing(a, t.id)).toBeNull();

		const utterances = [{ id: 'u1', speaker: 'speaker_0', start: 0, end: 900, text: 'The subway budget passes.', words: [{ text: 'The', start: 0, end: 100 }] }];
		const done = await completeTranscript(a, t.id, { text: 'The subway budget passes.', languageCode: 'eng', durationMs: 900, utterances });
		expect(done).toMatchObject({ status: 'complete', durationMs: 900, hasAudio: true, utterances });
		expect(await completeTranscript(a, t.id, { text: 'again', languageCode: null, durationMs: 1, utterances: [] })).toBeNull();

		expect((await listTranscripts(a, 'subway')).map((x) => x.id)).toEqual([t.id]);
		expect(await listTranscripts(a, 'zzz')).toEqual([]);
		expect(await listTranscripts(a, '%')).toEqual([]);
		expect(await listTranscripts(b)).toEqual([]);

		const renamed = await updateTranscript(a, t.id, { title: 'Budget vote', speakerNames: { speaker_0: 'Chow' } });
		expect(renamed).toMatchObject({ title: 'Budget vote', speakerNames: { speaker_0: 'Chow' }, utterances });
		expect(await updateTranscript(b, t.id, { title: 'x' })).toBeNull();
	});

	it('reclaims only stale processing runs and records failures', async () => {
		const t = await createTranscript({ ...base, accountId: a, title: 'Stale', sourceKind: 'link', sourceUrl: 'https://example.test/a.mp3' });
		expect(t).toMatchObject({ status: 'queued', audioKey: null });
		await claimForProcessing(a, t.id);
		expect(await claimForProcessing(a, t.id)).toBeNull();
		await sql`UPDATE transcripts SET processing_started_at = ${Date.now() - STALE_PROCESSING_MS - 1000} WHERE id = ${t.id}`;
		expect(await claimForProcessing(a, t.id)).toMatchObject({ status: 'processing' });
		expect(await failTranscript(a, t.id, 'engine_busy', 'Busy')).toMatchObject({ status: 'failed', errorCode: 'engine_busy' });
		expect(await claimForProcessing(a, t.id)).toMatchObject({ status: 'processing', errorCode: null });
	});

	it('deletes for the owner and with the account', async () => {
		const t = await createTranscript({ ...base, accountId: b, title: 'Gone' });
		expect(await deleteTranscript(a, t.id)).toBeNull();
		expect(await deleteTranscript(b, t.id)).toMatchObject({ id: t.id });
		const kept = await createTranscript({ ...base, accountId: b, title: 'Cascade' });
		await sql`DELETE FROM accounts WHERE id = ${b}`;
		expect(await getTranscript(b, kept.id)).toBeNull();
		await sql`INSERT INTO accounts (id,email,name,role,created_at,updated_at) VALUES (${b},${b + '@example.test'},'Transcripts test','member',1,1)`;
	});
});
