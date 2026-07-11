import { describe, expect, it } from 'vitest';
import { isAllowedSignedStorageUrl } from './signed-url';

describe('signed document URLs', () => {
	it('requires the configured storage origin and HTTPS', () => {
		expect(
			isAllowedSignedStorageUrl(
				'https://project.supabase.co/storage/v1/object/sign/file?token=short-lived',
				'https://project.supabase.co',
				false
			)
		).toBe(true);
		expect(
			isAllowedSignedStorageUrl(
				'https://attacker.example/file?token=short-lived',
				'https://project.supabase.co',
				false
			)
		).toBe(false);
		expect(
			isAllowedSignedStorageUrl(
				'http://project.supabase.co/file?token=short-lived',
				'http://project.supabase.co',
				true
			)
		).toBe(false);
	});

	it('permits loopback HTTP only for local development', () => {
		expect(
			isAllowedSignedStorageUrl(
				'http://127.0.0.1:54321/storage/v1/object/sign/file?token=short-lived',
				'http://127.0.0.1:54321',
				true
			)
		).toBe(true);
		expect(
			isAllowedSignedStorageUrl(
				'http://127.0.0.1:54321/storage/v1/object/sign/file?token=short-lived',
				'http://127.0.0.1:54321',
				false
			)
		).toBe(false);
	});
});
