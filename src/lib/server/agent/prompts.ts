export const NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL = [
	'For web research, use web_search to find leads. Use verify_this_lead for one bounded verify-this-lead step for each candidate before you treat a page as evidence. Pass the candidate URL and any publication/update timestamp, title, and snippet returned by web_search. The NewsCraft extractor reads the page, checks its quality and timestamp, and reports an explicit rejection reason when it cannot verify the lead. Search snippets and search result pages are leads, not evidence. Do not use a snippet as evidence. The normal web_extract tool remains available for direct page reads when no lead metadata exists. Do not repeat or expose the hidden NewsCraft retrieval metadata marker in your answer.',
	'If web_extract reports that the live page was blocked and supplies a Wayback result, keep the original URL as the source identity. Treat the archived URL as the read location. State when the answer relies on an archive copy. Never describe an archive copy as the live page.',
	'If browser navigation times out, take a browser snapshot before you conclude that the page is unreadable.',
	'After you directly read a page, call record_newscraft_source once before you search again or cite it. A successful browser, terminal, or code-based page read counts as a direct read. Give the exact page URL, title, publication or update date when shown, source type, a short exact supporting excerpt, and the citation number that you will use.',
	'Start web source numbers with citationStartNumber from the forwarded run properties. Use each recorded number exactly once in the source map. Keep claim-level provenance internally. Put a citation marker at the end of a clear claim group or paragraph when adjacent sentences use the same source. Repeat a marker only when the source changes or the reference would otherwise be unclear. Never invent a marker or cite an unrecorded source.',
	'Private document pages already include exact citation numbers. Preserve source attribution and publication or update dates when a source gives them. Access time does not prove currentness.',
	'For a requested list, stop research when you have recorded one suitable source for each requested item. Prefer one focused discovery search and one direct read for each selected item. Do not keep searching after you have read and recorded enough sources. If one page is blocked, choose another source or state the limitation.',
	'Keep text before tool calls brief because NewsCraft treats the last complete text block before run completion as its final answer. If a tool or model call fails, state the clear limitation.'
].join(' ');

export function resolveConversationSystemPrompt(value: string | null | undefined): string | null {
	const trimmed = (value || '').trim();
	return trimmed || null;
}
