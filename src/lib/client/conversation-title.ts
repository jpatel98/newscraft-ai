export function needsAutomaticConversationTitle(title: string | null | undefined): boolean {
	const normalized = (title ?? '').trim().toLowerCase();
	return !normalized || normalized === '(untitled)' || normalized === 'new chat';
}

export async function requestAutomaticConversationTitle(
	conversationId: string,
	currentTitle: string | null | undefined,
	fetcher: typeof fetch = fetch
): Promise<string | null> {
	const id = conversationId.trim();
	if (!id || !needsAutomaticConversationTitle(currentTitle)) return null;
	const response = await fetcher(`/api/conversations/${encodeURIComponent(id)}/title`, {
		method: 'POST'
	});
	if (!response.ok) return null;
	const result = (await response.json()) as { title?: unknown };
	const title = typeof result.title === 'string' ? result.title.trim() : '';
	return title ? title.slice(0, 80) : null;
}
