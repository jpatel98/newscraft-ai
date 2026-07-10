import { describe, expect, it } from 'vitest';
import {
	composerDraftStorageKey,
	readComposerDraft,
	writeComposerDraft
} from './composer-drafts';

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key)
	};
}

describe('composer draft storage', () => {
	it('keeps drafts isolated by explicit key', () => {
		const storage = memoryStorage();
		const first = composerDraftStorageKey('conversation-one');
		const second = composerDraftStorageKey('conversation-two');

		writeComposerDraft(storage, first, 'draft one');
		writeComposerDraft(storage, second, 'draft two');

		expect(readComposerDraft(storage, first)).toBe('draft one');
		expect(readComposerDraft(storage, second)).toBe('draft two');
	});

	it('removes empty drafts without touching other conversations', () => {
		const storage = memoryStorage();
		const first = composerDraftStorageKey('conversation-one');
		const second = composerDraftStorageKey('conversation-two');

		writeComposerDraft(storage, first, 'draft one');
		writeComposerDraft(storage, second, 'draft two');
		writeComposerDraft(storage, first, '   ');

		expect(readComposerDraft(storage, first)).toBe('');
		expect(readComposerDraft(storage, second)).toBe('draft two');
	});

	it('treats unavailable storage as an empty best-effort draft store', () => {
		const key = composerDraftStorageKey('conversation-one');
		const storage = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
			removeItem: () => {
				throw new Error('blocked');
			}
		};

		expect(readComposerDraft(storage, key)).toBe('');
		expect(() => writeComposerDraft(storage, key, 'draft')).not.toThrow();
	});
});
