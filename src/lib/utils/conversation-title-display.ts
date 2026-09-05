/**
 * Prefer a server-confirmed sidebar title when it is available. The automatic
 * title is a short-lived client overlay while a stream is active.
 */
export function selectConversationDisplayTitle(
	pageTitle: string | null | undefined,
	sidebarTitle: string | null | undefined,
	automaticTitle: string | null | undefined
): string {
	if (sidebarTitle && sidebarTitle !== '(untitled)') return sidebarTitle;
	return automaticTitle ?? pageTitle ?? '';
}
