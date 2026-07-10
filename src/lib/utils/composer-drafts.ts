const DRAFT_PREFIX = 'newscraft:composer-draft:';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function composerDraftStorageKey(draftKey: string | null | undefined): string | null {
	const normalized = (draftKey ?? '').trim();
	if (!normalized) return null;
	return `${DRAFT_PREFIX}${encodeURIComponent(normalized)}`;
}

export function readComposerDraft(storage: DraftStorage | null, key: string | null): string {
	if (!storage || !key) return '';
	try {
		return storage.getItem(key) ?? '';
	} catch {
		return '';
	}
}

export function writeComposerDraft(
	storage: DraftStorage | null,
	key: string | null,
	value: string
): void {
	if (!storage || !key) return;
	try {
		if (value.trim().length > 0) storage.setItem(key, value);
		else storage.removeItem(key);
	} catch {
		/* localStorage can be unavailable or full; drafts are best-effort. */
	}
}
