import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, relative, resolve } from 'node:path';

const port = Number.parseInt(process.env.PORT || '9100', 10);
const root = resolve(process.env.NEWSCRAFT_STORAGE_ROOT || '/srv/newscraft-storage');
const publicBaseUrl = (process.env.NEWSCRAFT_STORAGE_PUBLIC_URL || '').replace(/\/+$/u, '');
const apiKey = process.env.NEWSCRAFT_STORAGE_API_KEY || '';
const signingKey = process.env.NEWSCRAFT_STORAGE_SIGNING_KEY || '';
const corsOrigins = parseCorsOrigins(process.env.NEWSCRAFT_STORAGE_CORS_ORIGIN || '');
const documentBucket = process.env.NEWSCRAFT_DOCUMENT_BUCKET || 'newsroom-documents';
const artifactBucket = process.env.NEWSCRAFT_ARTIFACT_BUCKET || 'newsroom-artifacts';
const maxPdfBytes = 20 * 1024 * 1024;
const maxArtifactBytes = 20 * 1024 * 1024;
const artifactMimeTypes = new Set(['image/png', 'image/jpeg', 'text/csv', 'text/markdown', 'application/json']);

if (!apiKey || signingKey.length < 32 || !publicBaseUrl) {
	throw new Error('NEWSCRAFT_STORAGE_API_KEY, NEWSCRAFT_STORAGE_SIGNING_KEY (32+ chars), and NEWSCRAFT_STORAGE_PUBLIC_URL are required');
}

await mkdir(join(root, '.tokens'), { recursive: true, mode: 0o700 });
await mkdir(join(root, documentBucket), { recursive: true, mode: 0o700 });
await mkdir(join(root, artifactBucket), { recursive: true, mode: 0o700 });

const policies = new Map([
	[documentBucket, { private: true, maxBytes: maxPdfBytes, mimeTypes: ['application/pdf'] }],
	[artifactBucket, { private: true, maxBytes: maxArtifactBytes, mimeTypes: [...artifactMimeTypes].sort() }]
]);

const server = createServer(async (request, response) => {
	try {
		setCors(request, response);
		if (request.method === 'OPTIONS') return endJson(response, 204, null);
		const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
		if (request.method === 'GET' && url.pathname === '/health') return endJson(response, 200, { ok: true });
		if (request.method === 'GET' && url.pathname === '/v1/health') return endJson(response, 200, { ok: true });

		if (url.pathname.startsWith('/v1/upload/')) {
			if (request.method !== 'PUT') return endJson(response, 405, { detail: 'method not allowed' });
			return await handleSignedUpload(request, response, url, url.pathname.slice('/v1/upload/'.length));
		}
		if (url.pathname.startsWith('/v1/download/')) {
			if (request.method !== 'GET') return endJson(response, 405, { detail: 'method not allowed' });
			return await handleSignedDownload(response, url.pathname.slice('/v1/download/'.length));
		}

		if (!authorized(request)) return endJson(response, 401, { detail: 'unauthorized' });
		if (request.method === 'POST' && url.pathname === '/v1/sign-upload') return await handleSignUpload(request, response);
		if (request.method === 'POST' && url.pathname === '/v1/sign-download') return await handleSignDownload(request, response);
		if (request.method === 'GET' && url.pathname === '/v1/policy') return handlePolicy(response, url);
		if (url.pathname === '/v1/meta' && request.method === 'GET') return await handleMeta(response, url);
		if (url.pathname === '/v1/object' && request.method === 'GET') return await handleObjectGet(response, url);
		if (url.pathname === '/v1/object' && request.method === 'PUT') return await handleObjectPut(request, response, url);
		if (url.pathname === '/v1/object' && request.method === 'DELETE') return await handleObjectDelete(response, url);
		return endJson(response, 404, { detail: 'not found' });
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'request failed');
		if (!response.headersSent) {
			const status = error && typeof error === 'object' && 'status' in error && Number.isInteger(error.status)
				? Math.min(599, Math.max(400, Number(error.status)))
				: 500;
			endJson(response, status, { detail: status === 500 ? 'storage request failed' : (error instanceof Error ? error.message : 'invalid request') });
		}
		else response.destroy();
	}
});

server.listen(port, '0.0.0.0', () => console.log(`newscraft storage listening on ${port}`));

function authorized(request) {
	const candidate = request.headers['x-storage-key'];
	return typeof candidate === 'string' && safeEqual(candidate, apiKey);
}

async function handleSignUpload(request, response) {
	const body = await readJson(request, 64 * 1024);
	const policy = policies.get(body.bucket);
	const key = policy ? validateKey(body.bucket, body.key) : null;
	const contentType = typeof body.contentType === 'string' && body.contentType ? body.contentType.toLowerCase() : undefined;
	if (!policy || !key) return endJson(response, 400, { detail: 'bucket and key are required' });
	if (contentType && !policy.mimeTypes.includes(contentType)) return endJson(response, 415, { detail: 'content type is not allowed' });
	const requestedMax = Number(body.maxBytes);
	const maxBytes = Number.isSafeInteger(requestedMax) && requestedMax > 0 ? Math.min(requestedMax, policy.maxBytes) : policy.maxBytes;
	const token = signToken({ op: 'upload', bucket: body.bucket, key, contentType, maxBytes, exp: nowSeconds() + 900, nonce: randomUUID().replaceAll('-', '') });
	return endJson(response, 200, { path: key, token, signedUrl: `${publicBaseUrl}/v1/upload/${encodeURIComponent(token)}` });
}

async function handleSignDownload(request, response) {
	const body = await readJson(request, 64 * 1024);
	const key = policies.has(body.bucket) ? validateKey(body.bucket, body.key) : null;
	if (!key) return endJson(response, 400, { detail: 'bucket and key are required' });
	const requested = Number(body.expiresInSeconds);
	const ttl = Number.isSafeInteger(requested) ? Math.max(1, Math.min(requested, 900)) : 300;
	const token = signToken({ op: 'download', bucket: body.bucket, key, exp: nowSeconds() + ttl, nonce: randomUUID().replaceAll('-', '') });
	return endJson(response, 200, { signedUrl: `${publicBaseUrl}/v1/download/${encodeURIComponent(token)}` });
}

function handlePolicy(response, url) {
	const policy = policies.get(url.searchParams.get('bucket') || '');
	if (!policy) return endJson(response, 404, { detail: 'bucket not found' });
	return endJson(response, 200, policy);
}

async function handleSignedUpload(request, response, url, encodedToken) {
	const payload = verifyToken(encodedToken, 'upload');
	if (!payload) return endJson(response, 401, { detail: 'invalid or expired upload token' });
	const policy = policies.get(payload.bucket);
	if (!policy || !validateKey(payload.bucket, payload.key)) return endJson(response, 400, { detail: 'invalid upload target' });
	const contentType = normalizeContentType(request.headers['content-type']);
	if (payload.contentType && contentType !== payload.contentType) return endJson(response, 415, { detail: 'content type does not match token' });
	if (!payload.contentType && !policy.mimeTypes.includes(contentType)) return endJson(response, 415, { detail: 'content type is not allowed' });
	const declared = request.headers['content-length'] === undefined ? null : Number(request.headers['content-length']);
	if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > payload.maxBytes)) return endJson(response, 413, { detail: 'content length exceeds token bound' });
	const marker = join(root, '.tokens', payload.nonce);
	try {
		const markerHandle = await open(marker, 'wx', 0o600);
		await markerHandle.close();
	} catch {
		return endJson(response, 409, { detail: 'upload token already used' });
	}
	try {
		const metadata = await writeStreamedObject(request, payload.bucket, payload.key, contentType, payload.maxBytes);
		return endJson(response, 200, metadata);
	} catch (error) {
		return endJson(response, error?.status === 413 ? 413 : 422, { detail: error instanceof Error ? error.message : 'upload failed' });
	}
}

async function handleSignedDownload(response, encodedToken) {
	const payload = verifyToken(encodedToken, 'download');
	if (!payload || !policies.has(payload.bucket) || !validateKey(payload.bucket, payload.key)) return endJson(response, 404, { detail: 'object not found' });
	return streamLatest(response, payload.bucket, payload.key);
}

async function handleMeta(response, url) {
	const bucket = url.searchParams.get('bucket') || '';
	const key = validateKey(bucket, url.searchParams.get('key') || '');
	const version = url.searchParams.get('version') || undefined;
	if (!policies.has(bucket) || !key) return endJson(response, 400, { detail: 'bucket and key are required' });
	const metadata = await readMetadata(bucket, key, version);
	return metadata ? endJson(response, 200, metadata) : endJson(response, 404, { detail: 'object not found' });
}

async function handleObjectGet(response, url) {
	const bucket = url.searchParams.get('bucket') || '';
	const key = validateKey(bucket, url.searchParams.get('key') || '');
	const version = url.searchParams.get('version') || undefined;
	if (!policies.has(bucket) || !key) return endJson(response, 400, { detail: 'bucket and key are required' });
	const metadata = await readMetadata(bucket, key, version);
	if (!metadata) return endJson(response, 404, { detail: 'object not found' });
	return streamFile(response, objectPath(bucket, key, metadata.version), metadata);
}

async function handleObjectPut(request, response, url) {
	const bucket = url.searchParams.get('bucket') || '';
	const key = validateKey(bucket, url.searchParams.get('key') || '');
	const contentType = normalizeContentType(request.headers['content-type']);
	const policy = policies.get(bucket);
	if (!policy || !key || !policy.mimeTypes.includes(contentType)) return endJson(response, 415, { detail: 'invalid object target or content type' });
	try {
		return endJson(response, 200, await writeStreamedObject(request, bucket, key, contentType, policy.maxBytes));
	} catch (error) {
		return endJson(response, error?.status === 413 ? 413 : 422, { detail: error instanceof Error ? error.message : 'object write failed' });
	}
}

async function handleObjectDelete(response, url) {
	const bucket = url.searchParams.get('bucket') || '';
	const key = validateKey(bucket, url.searchParams.get('key') || '');
	const version = url.searchParams.get('version') || undefined;
	if (!policies.has(bucket) || !key) return endJson(response, 400, { detail: 'bucket and key are required' });
	if (version && !/^[a-f0-9]{32,80}$/u.test(version)) return endJson(response, 400, { detail: 'invalid object version' });
	if (!version) {
		await rm(keyDir(bucket, key), { recursive: true, force: true });
	} else {
		await rm(objectPath(bucket, key, version), { force: true });
		await rm(metadataPath(bucket, key, version), { force: true });
		await repairLatestAfterVersionDelete(bucket, key, version);
	}
	return endJson(response, 204, null);
}

async function writeStreamedObject(request, bucket, key, contentType, maxBytes) {
	const version = randomUUID().replaceAll('-', '');
	const destination = objectPath(bucket, key, version);
	const temp = join(root, '.tokens', `${randomUUID().replaceAll('-', '')}.part`);
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	let total = 0;
	const hash = createHash('sha256');
	const handle = await open(temp, 'wx', 0o600);
	let closed = false;
	let renamed = false;
	try {
		for await (const chunk of request) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += bytes.byteLength;
			if (total > maxBytes) {
				const error = new Error('object exceeds its size bound');
				error.status = 413;
				throw error;
			}
			hash.update(bytes);
			await handle.write(bytes);
		}
		if (total < 1) throw new Error('empty objects are not allowed');
		await handle.close();
		closed = true;
		await rename(temp, destination);
		renamed = true;
		const metadata = { key, version, bytes: total, checksumSha256: hash.digest('hex'), contentType, path: key };
		try {
			await writeMetadata(bucket, key, version, metadata);
			await writeLatest(bucket, key, metadata);
		} catch (error) {
			await rm(destination, { force: true });
			await rm(metadataPath(bucket, key, version), { force: true });
			throw error;
		}
		return metadata;
	} finally {
		if (!closed) await handle.close().catch(() => undefined);
		if (!renamed) await rm(temp, { force: true });
	}
}

async function streamLatest(response, bucket, key) {
	const metadata = await readMetadata(bucket, key);
	if (!metadata) return endJson(response, 404, { detail: 'object not found' });
	return streamFile(response, objectPath(bucket, key, metadata.version), metadata);
}

function streamFile(response, path, metadata) {
	response.writeHead(200, {
		'content-type': metadata.contentType,
		'content-length': String(metadata.bytes),
		'cache-control': 'private, no-store',
		'x-content-sha256': metadata.checksumSha256
	});
	createReadStream(path).on('error', () => response.destroy()).pipe(response);
}

async function readMetadata(bucket, key, version) {
	if (version && !validateVersion(version)) return null;
	const path = version ? metadataPath(bucket, key, version) : latestPath(bucket, key);
	try {
		const value = JSON.parse(await readFile(path, 'utf8'));
		if (
			(value.key !== key) ||
			(version && value.version !== version) ||
			!validateVersion(value.version) ||
			!Number.isSafeInteger(value.bytes) ||
			value.bytes < 1 ||
			typeof value.checksumSha256 !== 'string' ||
			!/^[a-f0-9]{64}$/u.test(value.checksumSha256) ||
			typeof value.contentType !== 'string' ||
			!policies.get(bucket)?.mimeTypes.includes(value.contentType)
		) return null;
		const object = await stat(objectPath(bucket, key, value.version));
		if (!object.isFile() || object.size !== value.bytes) return null;
		return value;
	} catch {
		return null;
	}
}

async function writeMetadata(bucket, key, version, metadata) {
	await writeFile(metadataPath(bucket, key, version), JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
}

async function writeLatest(bucket, key, metadata) {
	const path = latestPath(bucket, key);
	const temp = `${path}.${randomUUID().replaceAll('-', '')}.tmp`;
	try {
		await writeFile(temp, JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

function objectPath(bucket, key, version) {
	return join(keyDir(bucket, key), `${version}.bin`);
}

function validateVersion(value) {
	return typeof value === 'string' && /^[a-f0-9]{32,80}$/u.test(value);
}

function metadataPath(bucket, key, version) {
	return `${objectPath(bucket, key, version)}.json`;
}

function latestPath(bucket, key) {
	return join(keyDir(bucket, key), 'latest.json');
}

function keyDir(bucket, key) {
	return resolveInside(join(root, bucket), key);
}

function validateKey(bucket, value) {
	const key = String(value || '').trim();
	if (!policies.has(bucket) || !key || key.length > 512 || key.startsWith('/') || key.includes('..') || /[\u0000-\u001f]/u.test(key)) return null;
	const target = resolveInside(join(root, bucket), key);
	return target ? key : null;
}

async function repairLatestAfterVersionDelete(bucket, key, deletedVersion) {
	// `readMetadata` validates that the pointed-to object still exists. After
	// deleting the latest version that validation necessarily fails, so inspect
	// the pointer record itself before deciding whether it needs repair.
	let latest;
	try {
		latest = JSON.parse(await readFile(latestPath(bucket, key), 'utf8'));
	} catch {
		return;
	}
	if (!latest || latest.key !== key || latest.version !== deletedVersion) return;
	let candidates = [];
	try {
		for (const name of await readdir(keyDir(bucket, key))) {
			if (!name.endsWith('.bin.json') || name === 'latest.json') continue;
			const version = name.slice(0, -'.bin.json'.length);
			if (!validateVersion(version)) continue;
			const candidate = await readMetadata(bucket, key, version);
			if (!candidate) continue;
			const object = await stat(objectPath(bucket, key, version)).catch(() => null);
			if (object) candidates.push({ candidate, mtimeMs: object.mtimeMs });
		}
	} catch {
		candidates = [];
	}
	if (candidates.length === 0) {
		await rm(latestPath(bucket, key), { force: true });
		return;
	}
	candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
	await writeLatest(bucket, key, candidates[0].candidate);
}

function resolveInside(base, child) {
	const target = resolve(base, child);
	const rel = relative(base, target);
	if (!rel || rel.startsWith('..') || rel.includes(`${process.platform === 'win32' ? '\\' : '/'}..`) || target === base) return null;
	return target;
}

function signToken(payload) {
	const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const signature = createHmac('sha256', signingKey).update(encoded).digest('base64url');
	return `${encoded}.${signature}`;
}

function verifyToken(token, op) {
	try {
		const [encoded, signature] = decodeURIComponent(token).split('.', 2);
		if (!encoded || !signature) return null;
		const expected = createHmac('sha256', signingKey).update(encoded).digest('base64url');
		if (!safeEqual(signature, expected)) return null;
		const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
		return payload.op === op && Number(payload.exp) >= nowSeconds() ? payload : null;
	} catch {
		return null;
	}
}

function safeEqual(left, right) {
	const a = Buffer.from(String(left));
	const b = Buffer.from(String(right));
	return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeContentType(value) {
	return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

async function readJson(request, maxBytes) {
	let total = 0;
	const chunks = [];
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.byteLength;
		if (total > maxBytes) {
			const error = new Error('request body too large');
			error.status = 413;
			throw error;
		}
		chunks.push(bytes);
	}
	let value;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
	} catch {
		const error = new Error('invalid json');
		error.status = 400;
		throw error;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		const error = new Error('json object is required');
		error.status = 400;
		throw error;
	}
	return value;
}

function setCors(request, response) {
	const origin = request.headers.origin;
	if (origin && corsOrigins.size > 0) response.setHeader('vary', 'origin');
	if (origin && corsOrigins.has(origin)) {
		response.setHeader('access-control-allow-origin', origin);
		response.setHeader('access-control-allow-methods', 'GET,PUT,OPTIONS');
		response.setHeader('access-control-allow-headers', 'content-type,content-length');
	}
}

function parseCorsOrigins(value) {
	const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean);
	if (origins.includes('*')) throw new Error('NEWSCRAFT_STORAGE_CORS_ORIGIN must not contain a wildcard');
	for (const origin of origins) {
		let parsed;
		try {
			parsed = new URL(origin);
		} catch {
			throw new Error(`NEWSCRAFT_STORAGE_CORS_ORIGIN contains an invalid origin: ${origin}`);
		}
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
			throw new Error(`NEWSCRAFT_STORAGE_CORS_ORIGIN must contain origins only: ${origin}`);
		}
	}
	return new Set(origins);
}

function endJson(response, status, value) {
	if (status === 204) return response.writeHead(204).end();
	const body = JSON.stringify(value);
	response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
	response.end(body);
}
