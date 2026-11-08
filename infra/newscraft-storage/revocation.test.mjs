import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const apiKey = 'synthetic-storage-revocation-key';
const signingKey = 'synthetic-storage-revocation-signing-key';
const bucket = 'newsroom-documents';
const contentType = 'application/pdf';
const bytes = Buffer.from('%PDF synthetic bounded document');

async function startGateway(root) {
	const child = spawn(process.execPath, ['server.mjs'], {
		cwd: join(process.cwd(), 'infra', 'newscraft-storage'),
		env: {
			PATH: process.env.PATH,
			TMPDIR: '/private/tmp',
			PORT: '0',
			NEWSCRAFT_STORAGE_HOST: '127.0.0.1',
			NEWSCRAFT_STORAGE_ROOT: root,
			NEWSCRAFT_STORAGE_API_KEY: apiKey,
			NEWSCRAFT_STORAGE_SIGNING_KEY: signingKey,
			NEWSCRAFT_STORAGE_PUBLIC_URL: 'http://127.0.0.1'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let diagnostics = '';
	child.stderr.on('data', (chunk) => { diagnostics += String(chunk); });
	const exited = once(child, 'exit');
	try {
		const port = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Synthetic storage startup timed out')), 5000);
			const finish = (error, value) => {
				clearTimeout(timer);
				if (error) reject(error);
				else resolve(value);
			};
			let output = '';
			child.stdout.on('data', (chunk) => {
				output += String(chunk);
				const match = /newscraft storage listening on (\d+)/u.exec(output);
				if (match) finish(null, Number(match[1]));
			});
			child.once('error', () => finish(new Error('Synthetic storage could not start')));
			child.once('exit', () => finish(new Error(`Synthetic storage exited: ${diagnostics.replaceAll(apiKey, '[redacted]').replaceAll(signingKey, '[redacted]')}`)));
		});
		return {
			base: `http://127.0.0.1:${port}`,
			diagnostics: () => diagnostics,
			async stop(signal = 'SIGTERM') {
				if (child.exitCode === null && child.signalCode === null) child.kill(signal);
				await exited;
			}
		};
	} catch (error) {
		child.kill('SIGKILL');
		await exited.catch(() => undefined);
		throw error;
	}
}

async function fixture(context) {
	const root = await mkdtemp(join(tmpdir(), 'newscraft-storage-revocation-'));
	let gateway;
	context.after(async () => {
		if (gateway) await gateway.stop();
		await rm(root, { recursive: true, force: true });
	});
	gateway = await startGateway(root);
	return {
		root,
		get base() { return gateway.base; },
		diagnostics: () => gateway.diagnostics(),
		async restart() {
			await gateway.stop('SIGKILL');
			gateway = await startGateway(root);
		},
		request(path, options = {}) {
			return fetch(gateway.base + path, { ...options, signal: AbortSignal.timeout(4000) });
		},
		control(path, body) {
			return this.request(path, { method: 'POST', headers: {
				'x-storage-key': apiKey, 'content-type': 'application/json'
			}, body: JSON.stringify(body) });
		},
		sign(key, selectedBucket = bucket, type = contentType) {
			return this.control('/v1/sign-upload', { bucket: selectedBucket, key, contentType: type, maxBytes: 1024 });
		},
		object(method, key, extra = {}, selectedBucket = bucket, body) {
			const query = new URLSearchParams({ bucket: selectedBucket, key, ...extra });
			return this.request(`/v1/object?${query}`, { method, headers: {
				'x-storage-key': apiKey, 'content-type': selectedBucket === 'newsroom-artifacts' ? 'text/markdown' : contentType
			}, ...(body === undefined ? {} : { body }) });
		},
		upload(token, body = bytes, type = contentType) {
			return this.request(`/v1/upload/${encodeURIComponent(token)}`, {
				method: 'PUT', headers: { 'content-type': type }, body
			});
		}
	};
}

async function grant(storage, key, selectedBucket = bucket, type = contentType) {
	const response = await storage.sign(key, selectedBucket, type);
	assert.equal(response.status, 200);
	return response.json();
}

function legacyToken(key) {
	const payload = { op: 'upload', bucket, key, maxBytes: 1024,
		exp: Math.floor(Date.now() / 1000) + 900, nonce: randomUUID().replaceAll('-', '') };
	const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `${encoded}.${createHmac('sha256', signingKey).update(encoded).digest('base64url')}`;
}

async function waitForPartialFile(root, minimumBytes) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		for (const name of await readdir(join(root, '.tokens'))) {
			if (name.endsWith('.part') && (await stat(join(root, '.tokens', name))).size >= minimumBytes) return;
		}
		await delay(10);
	}
	throw new Error('Synthetic upload did not enter its partial write');
}

test('flagged deletion revokes unused grants and future writes without exposing token material', async (context) => {
	const storage = await fixture(context);
	const key = 'account/evidence/unused.pdf';
	const signed = await grant(storage, key);
	const deleted = await storage.object('DELETE', key, { revokeUploads: 'true' });
	assert.equal(deleted.status, 204);
	assert.equal(deleted.headers.get('x-newscraft-upload-revoked'), '1');
	assert.equal((await storage.upload(signed.token)).status, 409);
	assert.equal((await storage.sign(key)).status, 409);
	assert.equal((await storage.object('PUT', key, {}, bucket, bytes)).status, 409);
	assert.equal((await storage.object('GET', key)).status, 404);
	const retried = await storage.object('DELETE', key, { revokeUploads: 'true' });
	assert.equal(retried.status, 204);
	assert.equal(retried.headers.get('x-newscraft-upload-revoked'), '1');
	const unflagged = await storage.object('DELETE', key);
	assert.equal(unflagged.status, 204);
	assert.equal(unflagged.headers.get('x-newscraft-upload-revoked'), null);
	assert.equal((await storage.upload(signed.token)).status, 409);
	const marker = createHash('sha256').update(JSON.stringify([bucket, key])).digest('hex');
	assert.deepEqual(await readdir(join(storage.root, '.revoked-uploads')), [marker]);
	assert.equal((await lstat(join(storage.root, '.revoked-uploads'))).mode & 0o777, 0o700);
	assert.equal((await lstat(join(storage.root, '.revoked-uploads', marker))).mode & 0o777, 0o600);
	await assert.rejects(lstat(join(storage.root, bucket, key)), { code: 'ENOENT' });
	assert.ok(!storage.diagnostics().includes(signed.token));
	assert.ok(!storage.diagnostics().includes(signingKey));
});

for (const signedUpload of [true, false]) {
	test(`flagged deletion fences an in-flight ${signedUpload ? 'signed upload' : 'authenticated write'} before commit`, async (context) => {
		const storage = await fixture(context);
		const key = 'account/evidence/interleaving.pdf';
		assert.equal((await storage.object('PUT', key, {}, bucket, bytes)).status, 200);
		const signed = await grant(storage, key);
		const path = signedUpload ? `/v1/upload/${encodeURIComponent(signed.token)}` :
			`/v1/object?${new URLSearchParams({ bucket, key })}`;
		const upload = httpRequest(storage.base + path, { method: 'PUT', headers: {
			'content-type': contentType, 'content-length': String(bytes.length),
			...(signedUpload ? {} : { 'x-storage-key': apiKey })
		} });
		upload.setTimeout(4000, () => upload.destroy(new Error('Synthetic upload timed out')));
		const completed = new Promise((resolve, reject) => {
			upload.on('response', (response) => {
				response.resume();
				response.on('end', () => resolve(response.statusCode));
				response.on('error', reject);
			});
			upload.on('error', reject);
		});
		completed.catch(() => undefined);
		try {
			upload.write(bytes.subarray(0, 8));
			await waitForPartialFile(storage.root, 8);
			assert.equal((await storage.object('DELETE', key, { revokeUploads: 'true' })).status, 204);
			await assert.rejects(lstat(join(storage.root, bucket, key)), { code: 'ENOENT' });
			upload.end(bytes.subarray(8));
			assert.equal(await completed, 409);
			assert.equal((await storage.object('GET', key)).status, 404);
			assert.equal((await readdir(join(storage.root, '.tokens'))).filter((name) => name.endsWith('.part')).length, 0);
			await assert.rejects(lstat(join(storage.root, bucket, key)), { code: 'ENOENT' });
		} finally {
			upload.destroy();
		}
	});
}

test('completed uploads remain deleted after restart while other keys and buckets retain access', async (context) => {
	const storage = await fixture(context);
	const key = 'account/evidence/persistent.pdf';
	const completed = await grant(storage, key);
	const unused = await grant(storage, key);
	assert.equal((await storage.upload(completed.token)).status, 200);
	const neighbor = await grant(storage, 'account/evidence/neighbor.pdf');
	const audio = await grant(storage, key, 'newsroom-audio', 'audio/mpeg');
	assert.equal((await storage.object('DELETE', key, { revokeUploads: 'true' })).status, 204);
	await storage.restart();
	const retried = await storage.object('DELETE', key, { revokeUploads: 'true' });
	assert.equal(retried.status, 204);
	assert.equal(retried.headers.get('x-newscraft-upload-revoked'), '1');
	assert.equal((await storage.upload(unused.token)).status, 409);
	assert.equal((await storage.sign(key)).status, 409);
	assert.equal((await storage.object('PUT', key, {}, bucket, bytes)).status, 409);
	assert.equal((await storage.object('GET', key)).status, 404);
	assert.equal((await storage.upload(neighbor.token)).status, 200);
	assert.equal((await storage.upload(audio.token, bytes, 'audio/mpeg')).status, 200);
	assert.equal((await storage.upload(neighbor.token)).status, 409);
});

test('unflagged deletion retains reusable keys and artifact version repair', async (context) => {
	const storage = await fixture(context);
	const key = 'account/artifacts/report.md';
	const selectedBucket = 'newsroom-artifacts';
	const first = await storage.object('PUT', key, {}, selectedBucket, 'first');
	assert.equal(first.status, 200);
	const older = await first.json();
	const second = await storage.object('PUT', key, {}, selectedBucket, 'second');
	assert.equal(second.status, 200);
	const newer = await second.json();
	assert.notEqual(older.version, newer.version);
	assert.equal((await storage.object('DELETE', key, { version: newer.version }, selectedBucket)).status, 204);
	assert.equal(await (await storage.object('GET', key, {}, selectedBucket)).text(), 'first');
	const outstanding = await grant(storage, key, selectedBucket, 'text/markdown');
	assert.equal((await storage.object('DELETE', key, {}, selectedBucket)).status, 204);
	assert.equal((await storage.upload(outstanding.token, 'replacement', 'text/markdown')).status, 200);
	assert.equal((await storage.upload(outstanding.token, 'replay', 'text/markdown')).status, 409);
	assert.equal((await storage.sign(key, selectedBucket, 'text/markdown')).status, 200);
	assert.deepEqual(await readdir(join(storage.root, '.revoked-uploads')), []);
});

test('legacy HMAC grants remain one-use and canonical key aliases cannot bypass revocation', async (context) => {
	const storage = await fixture(context);
	const token = legacyToken('account/evidence/legacy.pdf');
	assert.equal((await storage.upload(token)).status, 200);
	assert.equal((await storage.upload(token)).status, 409);
	const key = 'account/evidence/aliases.pdf';
	const aliases = [key, 'account//evidence/aliases.pdf', 'account/./evidence/aliases.pdf', key + '/'];
	const tokens = aliases.map(legacyToken);
	assert.equal((await storage.object('DELETE', aliases[1], { revokeUploads: 'true' })).status, 204);
	for (const [index, alias] of aliases.entries()) {
		assert.equal((await storage.upload(tokens[index])).status, 409);
		assert.equal((await storage.sign(alias)).status, 409);
	}
});

test('missing or replaced revocation state fails closed instead of treating old grants as valid', async (context) => {
	const storage = await fixture(context);
	const key = 'account/evidence/unavailable.pdf';
	const signed = await grant(storage, key);
	const revocations = join(storage.root, '.revoked-uploads');
	await rename(revocations, join(storage.root, 'saved-revocations'));
	for (const replacement of [false, true]) {
		if (replacement) await mkdir(revocations, { mode: 0o700 });
		assert.equal((await storage.sign(key)).status, 503);
		assert.equal((await storage.upload(signed.token)).status, 503);
		assert.equal((await storage.object('PUT', key, {}, bucket, bytes)).status, 503);
		const deleted = await storage.object('DELETE', key, { revokeUploads: 'true' });
		assert.equal(deleted.status, 503);
		assert.equal(deleted.headers.get('x-newscraft-upload-revoked'), null);
	}
});

test('health and bucket policy advertise upload revocation without changing access or bucket bounds', async (context) => {
	const storage = await fixture(context);
	for (const path of ['/health', '/v1/health']) {
		const response = await storage.request(path);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, supportsUploadRevocation: true });
	}
	for (const [selectedBucket, maxBytes, type] of [
		[bucket, 20 * 1024 * 1024, contentType],
		['newsroom-artifacts', 20 * 1024 * 1024, 'text/markdown'],
		['newsroom-audio', 1024 * 1024 * 1024, 'audio/mpeg']
	]) {
		const path = `/v1/policy?${new URLSearchParams({ bucket: selectedBucket })}`;
		assert.equal((await storage.request(path)).status, 401);
		const response = await storage.request(path, { headers: { 'x-storage-key': apiKey } });
		assert.equal(response.status, 200);
		const policy = await response.json();
		assert.equal(policy.supportsUploadRevocation, true);
		assert.equal(policy.private, true);
		assert.equal(policy.maxBytes, maxBytes);
		assert.ok(policy.mimeTypes.includes(type));
	}
});

test('revocation acknowledgement is absent for failed or non-opted-in deletions', async (context) => {
	const storage = await fixture(context);
	const key = 'account/evidence/acknowledgement.pdf';
	const query = new URLSearchParams({ bucket, key, revokeUploads: 'true' });
	const unauthorized = await storage.request(`/v1/object?${query}`, { method: 'DELETE' });
	assert.equal(unauthorized.status, 401);
	assert.equal(unauthorized.headers.get('x-newscraft-upload-revoked'), null);
	const invalid = await storage.object('DELETE', key, { version: 'invalid', revokeUploads: 'true' });
	assert.equal(invalid.status, 400);
	assert.equal(invalid.headers.get('x-newscraft-upload-revoked'), null);
	const unflagged = await storage.object('DELETE', key, { revokeUploads: 'false' });
	assert.equal(unflagged.status, 204);
	assert.equal(unflagged.headers.get('x-newscraft-upload-revoked'), null);
	assert.equal((await storage.sign(key)).status, 200);
	const version = randomUUID().replaceAll('-', '');
	await mkdir(join(storage.root, bucket, key, `${version}.bin`), { recursive: true, mode: 0o700 });
	const failed = await storage.object('DELETE', key, { version, revokeUploads: 'true' });
	assert.equal(failed.status, 500);
	assert.equal(failed.headers.get('x-newscraft-upload-revoked'), null);
	assert.equal((await storage.sign(key)).status, 409);
	const retried = await storage.object('DELETE', key, { revokeUploads: 'true' });
	assert.equal(retried.status, 204);
	assert.equal(retried.headers.get('x-newscraft-upload-revoked'), '1');
});

test('invalid bind hosts fail before creating storage or opening a listener', async (context) => {
	const root = await mkdtemp(join(tmpdir(), 'newscraft-storage-bind-'));
	context.after(() => rm(root, { recursive: true, force: true }));
	for (const host of ['localhost', 'http://127.0.0.1', '', '127.0.0.999']) {
		const result = spawnSync(process.execPath, ['server.mjs'], {
			cwd: join(process.cwd(), 'infra', 'newscraft-storage'),
			env: {
				PATH: process.env.PATH, TMPDIR: '/private/tmp', PORT: '0',
				NEWSCRAFT_STORAGE_HOST: host,
				NEWSCRAFT_STORAGE_ROOT: root,
				NEWSCRAFT_STORAGE_API_KEY: apiKey,
				NEWSCRAFT_STORAGE_SIGNING_KEY: signingKey,
				NEWSCRAFT_STORAGE_PUBLIC_URL: 'http://127.0.0.1'
			},
			encoding: 'utf8', timeout: 5000
		});
		assert.ifError(result.error);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /NEWSCRAFT_STORAGE_HOST must be an IP address/u);
		assert.ok(!result.stdout.includes('newscraft storage listening'));
		assert.deepEqual(await readdir(root), []);
	}
});
