import { error } from '@sveltejs/kit';
import { getProject } from '$lib/server/db/projects';
import { DocumentError } from '$lib/server/documents/errors';
import type { OwnedProject } from './types';
import { isMissingEvidenceTablesError } from './runtime';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const noStoreHeaders = NO_STORE;

/**
 * Resolve the project from the session and the path, never from the body. A
 * project that is not owned by the signed-in account is indistinguishable
 * from one that does not exist.
 */
export async function requireOwnedProject(locals: App.Locals, projectId: string | undefined): Promise<OwnedProject> {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!projectId) throw error(400, 'project id required');
	const project = await getProject(locals.user.id, projectId);
	if (!project) throw error(404, 'Project not found');
	return { id: project.id, accountId: locals.user.id, orgId: null };
}

export function throwEvidenceHttpError(cause: unknown): never {
	if (cause instanceof DocumentError) throw error(cause.status, cause.message);
	if (isMissingEvidenceTablesError(cause)) throw error(503, 'Evidence is not enabled on this deployment yet.');
	if (cause && typeof cause === 'object' && 'status' in cause && 'body' in cause) throw cause as never;
	throw error(500, 'The evidence request could not be completed.');
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
	const limit = 16 * 1024;
	if (Number(request.headers.get('content-length')) > limit) throw error(413, 'Evidence metadata exceeds 16 KiB.');
	const reader = request.body?.getReader();
	if (!reader) throw error(400, 'invalid json');
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel().catch(() => undefined);
				throw error(413, 'Evidence metadata exceeds 16 KiB.');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw error(400, 'invalid json');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'Expected an object');
	return body as Record<string, unknown>;
}
