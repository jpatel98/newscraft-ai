import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const apiKey = 'test-storage-key';

test('stores audio in the audio bucket and serves byte ranges for seeking', async () => {
	const root = await mkdtemp(join(tmpdir(), 'newscraft-storage-audio-'));
	const port = 19700 + (process.pid % 200);
	const publicUrl = `http://127.0.0.1:${port}`;
	const child = spawn(process.execPath, ['server.mjs'], {
		cwd: join(process.cwd(), 'infra', 'newscraft-storage'),
		env: {
			...process.env,
			PORT: String(port),
			NEWSCRAFT_STORAGE_ROOT: root,
			NEWSCRAFT_STORAGE_API_KEY: apiKey,
			NEWSCRAFT_STORAGE_SIGNING_KEY: 'test-signing-key-that-is-at-least-32-bytes',
			NEWSCRAFT_STORAGE_PUBLIC_URL: publicUrl,
			NEWSCRAFT_STORAGE_CORS_ORIGIN: 'https://agent.newscraftai.com'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	child.stderr.on('data', (chunk) => { output += chunk; });
	try {
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`storage server did not start: ${output}`)), 5000);
			child.stdout.on('data', (chunk) => {
				if (String(chunk).includes('newscraft storage listening')) {
					clearTimeout(timeout);
					resolve();
				}
			});
			child.once('error', reject);
		});
		const control = (path, body) => fetch(`${publicUrl}${path}`, {
			method: 'POST',
			headers: { 'x-storage-key': apiKey, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});

		const policy = await fetch(`${publicUrl}/v1/policy?bucket=newsroom-audio`, { headers: { 'x-storage-key': apiKey } });
		assert.equal(policy.status, 200);
		assert.ok((await policy.json()).mimeTypes.includes('audio/mpeg'));

		const refused = await control('/v1/sign-upload', { bucket: 'newsroom-audio', key: 'a/b.pdf', contentType: 'application/pdf' });
		assert.equal(refused.status, 415);

		const signed = await (await control('/v1/sign-upload', { bucket: 'newsroom-audio', key: 'acct/t1/audio', contentType: 'audio/mpeg', maxBytes: 1000 })).json();
		const bytes = Buffer.from('0123456789abcdefghij');
		const put = await fetch(signed.signedUrl, { method: 'PUT', headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) }, body: bytes });
		assert.equal(put.status, 200);

		const { signedUrl } = await (await control('/v1/sign-download', { bucket: 'newsroom-audio', key: 'acct/t1/audio', expiresInSeconds: 60 })).json();
		const whole = await fetch(signedUrl);
		assert.equal(whole.status, 200);
		assert.equal(whole.headers.get('accept-ranges'), 'bytes');
		assert.equal(await whole.text(), bytes.toString());

		const part = await fetch(signedUrl, { headers: { range: 'bytes=5-9' } });
		assert.equal(part.status, 206);
		assert.equal(part.headers.get('content-range'), 'bytes 5-9/20');
		assert.equal(await part.text(), '56789');

		const tail = await fetch(signedUrl, { headers: { range: 'bytes=-3' } });
		assert.equal(tail.status, 206);
		assert.equal(await tail.text(), 'hij');

		const open = await fetch(signedUrl, { headers: { range: 'bytes=15-' } });
		assert.equal(await open.text(), 'fghij');

		const beyond = await fetch(signedUrl, { headers: { range: 'bytes=40-50' } });
		assert.equal(beyond.status, 416);
		assert.equal(beyond.headers.get('content-range'), 'bytes */20');
	} finally {
		child.kill('SIGTERM');
		await new Promise((resolve) => child.once('exit', resolve));
		await rm(root, { recursive: true, force: true });
	}
});
