import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentError } from '$lib/server/documents/errors';

const mocks = vi.hoisted(() => ({ removeEvidenceProject: vi.fn(), deleteProject: vi.fn(), renameProject: vi.fn() }));
vi.mock('$lib/server/db/projects', () => ({ deleteProject: mocks.deleteProject, renameProject: mocks.renameProject }));
vi.mock('$lib/server/evidence/runtime', () => ({
	getProjectEvidenceService: () => ({ deleteProject: mocks.removeEvidenceProject }),
	isMissingEvidenceTablesError: (cause: unknown) => (cause as { code?: string })?.code === '42P01'
}));
vi.mock('$lib/server/evidence/http', () => ({
	throwEvidenceHttpError: (cause: unknown) => { throw cause; }
}));

import { DELETE } from './+server';

const event = (authenticated = true) => ({ locals: { user: authenticated ? { id: 'account-a' } : null }, params: { id: 'project-a' } }) as Parameters<typeof DELETE>[0];

describe('atomic evidence-aware folder deletion', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.removeEvidenceProject.mockResolvedValue(undefined);
		mocks.deleteProject.mockResolvedValue(true);
	});

	it('denies missing sessions without touching a repository', async () => {
		await expect(DELETE(event(false))).rejects.toMatchObject({ status: 401 });
		expect(mocks.removeEvidenceProject).not.toHaveBeenCalled();
		expect(mocks.deleteProject).not.toHaveBeenCalled();
	});

	it('uses one scoped atomic operation rather than checking evidence then deleting', async () => {
		expect((await DELETE(event())).status).toBe(200);
		expect(mocks.removeEvidenceProject).toHaveBeenCalledWith('account-a', 'project-a');
		expect(mocks.deleteProject).not.toHaveBeenCalled();
	});

	it('does not fall through after a nonempty or foreign project rejection', async () => {
		for (const status of [409, 404]) {
			mocks.removeEvidenceProject.mockRejectedValue(new DocumentError(status, 'project_unavailable', 'Unavailable'));
			await expect(DELETE(event())).rejects.toMatchObject({ status });
		}
		expect(mocks.deleteProject).not.toHaveBeenCalled();
	});

	it('preserves pre-migration folder deletion only when evidence tables are absent', async () => {
		mocks.removeEvidenceProject.mockRejectedValue(Object.assign(new Error('Synthetic missing relation'), { code: '42P01' }));
		expect((await DELETE(event())).status).toBe(200);
		expect(mocks.deleteProject).toHaveBeenCalledWith('account-a', 'project-a');
	});

	it('does not bypass the guard for an unrelated database failure', async () => {
		mocks.removeEvidenceProject.mockRejectedValue(new Error('Synthetic database failure'));
		await expect(DELETE(event())).rejects.toThrow('Synthetic database failure');
		expect(mocks.deleteProject).not.toHaveBeenCalled();
	});
});
