import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const environment = vi.hoisted(() => ({ NEWSCRAFT_STORAGE_PROVIDER: '', NEWSCRAFT_STORAGE_BASE_URL: 'https://objects.example.test', NEWSCRAFT_STORAGE_API_KEY: 'fixture-key' }));
const cloud = vi.hoisted(() => ({ createClient: vi.fn(() => { throw new Error('Unexpected cloud SDK'); }) }));
vi.mock('$env/dynamic/private', () => ({ env: environment }));
vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('@supabase/supabase-js', () => cloud);
import { artifactStorageMode, createArtifactObjectStorage } from '$lib/server/artifacts/storage';
import { createDocumentStorage } from '$lib/server/documents/storage';
describe('object storage selection without Supabase', () => {
    beforeEach(() => { vi.clearAllMocks(); environment.NEWSCRAFT_STORAGE_PROVIDER = ''; });
    afterEach(() => vi.unstubAllGlobals());
    it('uses the existing VPS adapter for documents and artifacts with no cloud variables', async () => {
        const fetcher = vi.fn(async () => new Response('{}', { status: 404 })); vi.stubGlobal('fetch', fetcher);
        expect(artifactStorageMode()).toBe('vps');
        expect(await createArtifactObjectStorage().stat('account/artifact/file', 'version-one')).toBeNull();
        await expect(createDocumentStorage().download('account/document/file.pdf')).rejects.toMatchObject({ code: 'upload_not_ready' });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls.every((args: any[]) => String(args[0]).startsWith('https://objects.example.test/'))).toBe(true);
        expect(cloud.createClient).not.toHaveBeenCalled();
    });
    it('fails explicit unconfigured cloud selection instead of changing providers silently', () => {
        environment.NEWSCRAFT_STORAGE_PROVIDER = 'supabase';
        expect(artifactStorageMode()).toBe('disabled');
        expect(() => createArtifactObjectStorage()).toThrow();
    });
});
