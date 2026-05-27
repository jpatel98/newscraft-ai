import { mergeToolBudget, type ToolBudget } from './budget.js';

type ToolMode =
	| 'answer_from_memory'
	| 'custom_tool'
	| 'source_monitor'
	| 'web_search'
	| 'browser_automation'
	| 'hybrid_research'
	| 'clarification_needed';

export interface RouteDecision {
	selected_mode: ToolMode;
	reason: string;
	tools_to_use: string[];
	tool_budget: ToolBudget;
	stop_condition: string;
	expected_output: string;
}

export interface RouterOptions {
	default_tool_budget?: Partial<ToolBudget>;
}

export const NEWSROOM_TOOL_NAMES = {
	sourceMonitor: 'configured_source_monitor',
	sourceFeedFetcher: 'source_feed_fetcher',
	missionResultReader: 'mission_result_reader',
	webSearch: 'openai_web_search',
	browserAutomation: 'browser_automation_provider',
	pdfTextExtractor: 'pdf_text_extractor',
	briefGenerator: 'newsroom_brief_generator'
} as const;

export function routeNewsroomRequest(prompt: string, options: RouterOptions = {}): RouteDecision {
	const text = normalize(prompt);
	const budget = mergeToolBudget(options.default_tool_budget);

	if (!text || isAmbiguousReference(text)) {
		return decision(
			'clarification_needed',
			'The request does not identify a source, story, mission output, or concrete newsroom task.',
			[],
			budget,
			'stop immediately and ask for the missing source or story target',
			'a short clarification request'
		);
	}

	if (mentionsBrowserAutomation(text)) {
		return decision(
			'browser_automation',
			'The request requires direct page interaction or dynamic page inspection.',
			[NEWSROOM_TOOL_NAMES.browserAutomation],
			budget,
			'stop after the browser task succeeds, is blocked, or reaches the browser budget',
			'evidence from direct page inspection or a clear limitation'
		);
	}

	if (mentionsMissionOutput(text)) {
		return decision(
			'custom_tool',
			'The request asks for saved NewsCraft mission output.',
			[NEWSROOM_TOOL_NAMES.missionResultReader],
			budget,
			'stop after the latest relevant mission output is found or confirmed unavailable',
			'a concise answer grounded in saved mission evidence'
		);
	}

	if (mentionsPdfOrDocument(text)) {
		return decision(
			'custom_tool',
			'The request asks to extract or summarize a PDF/source document.',
			[NEWSROOM_TOOL_NAMES.pdfTextExtractor],
			budget,
			'stop after text is extracted or the source is unavailable',
			'an evidence-backed document summary'
		);
	}

	const wantsOtherOutlets = mentionsOtherOutlets(text);
	const wantsConfiguredSources = mentionsConfiguredSource(text);
	const wantsCurrentSources = mentionsCurrentSourceCheck(text);
	const hasUrl = /https?:\/\//i.test(text);

	if ((wantsCurrentSources || hasUrl) && wantsOtherOutlets) {
		return decision(
			'hybrid_research',
			'The request needs both primary/source evidence and broader coverage context.',
			[NEWSROOM_TOOL_NAMES.sourceMonitor, NEWSROOM_TOOL_NAMES.webSearch],
			budget,
			'stop after primary/source evidence and broader coverage evidence exist, or a budget/availability limit is hit',
			'a producer-ready answer separating official or primary sources from media reports'
		);
	}

	if (wantsConfiguredSources || wantsCurrentSources) {
		return decision(
			'source_monitor',
			'The request targets configured sources, feeds, releases, or source monitors.',
			[NEWSROOM_TOOL_NAMES.sourceMonitor, NEWSROOM_TOOL_NAMES.webSearch],
			budget,
			'stop when configured-source evidence is sufficient, or use web search if configured sources are unavailable',
			'a concise monitored-source brief with provenance or a clean no-lead result'
		);
	}

	if (wantsOtherOutlets || mentionsBroadDiscovery(text)) {
		return decision(
			'web_search',
			'The request asks for broad discovery, related coverage, or what other outlets are reporting.',
			[NEWSROOM_TOOL_NAMES.webSearch],
			budget,
			'stop when enough web-search evidence exists or the web search budget/provider is unavailable',
			'a sourced answer summarizing related coverage and uncertainty'
		);
	}

	if (hasUrl || mentionsCustomTool(text)) {
		return decision(
			'custom_tool',
			'The request can be handled by an internal newsroom tool rather than broad search.',
			[hasUrl ? NEWSROOM_TOOL_NAMES.sourceFeedFetcher : NEWSROOM_TOOL_NAMES.briefGenerator],
			budget,
			'stop after the internal tool returns evidence or a clear limitation',
			'an answer grounded in custom-tool evidence'
		);
	}

	return decision(
		'answer_from_memory',
		'The request appears to be general newsroom guidance that does not require fresh source retrieval.',
		[],
		budget,
		'stop without calling tools',
		'a direct answer without pretending to have checked live sources'
	);
}

function decision(
	selected_mode: ToolMode,
	reason: string,
	tools_to_use: string[],
	tool_budget: ToolBudget,
	stop_condition: string,
	expected_output: string
): RouteDecision {
	return { selected_mode, reason, tools_to_use, tool_budget, stop_condition, expected_output };
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isAmbiguousReference(text: string): boolean {
	return /^(summarize|check|research|verify|look into|what about|update me|latest)\s*(this|that|it|story)?\??$/.test(text);
}

function mentionsBrowserAutomation(text: string): boolean {
	return /\b(browser|browse|click|screenshot|scroll|interactive|dynamic page|javascript-rendered|log in|login|captcha|paywall)\b/.test(
		text
	);
}

function mentionsMissionOutput(text: string): boolean {
	return /\b(mission output|mission report|saved mission|latest mission|last mission|previous mission|stored report)\b/.test(
		text
	);
}

function mentionsPdfOrDocument(text: string): boolean {
	return /\b(pdf|document extractor|extract text|source document|filing|uploaded document)\b/.test(text) || /\.pdf\b/.test(text);
}

function mentionsOtherOutlets(text: string): boolean {
	return /\b(other outlets|media reports|what outlets|coverage elsewhere|related coverage|reporting about|who else is reporting|broader coverage)\b/.test(
		text
	);
}

function mentionsConfiguredSource(text: string): boolean {
	return /\b(configured source|source monitor|source monitors|monitor list|rss|feed|feeds|watchlist)\b/.test(text);
}

function mentionsCurrentSourceCheck(text: string): boolean {
	return /\b(check|scan|monitor|release|releases|press release|police|public safety)\b/.test(text);
}

function mentionsBroadDiscovery(text: string): boolean {
	return (
		/\b(web search|search the web|find sources|broad context|background coverage|latest on|roundup|trend)\b/.test(text) ||
		/\b(latest|today|tomorrow|tonight|forecast|new|recent|breaking|current)\b.*\b(news|coverage|reports?|updates?|story|stories|prices?|rates?|on)\b/.test(text) ||
		/\b(news|coverage|reports?|updates?|story|stories|prices?|rates?)\b.*\b(latest|today|tomorrow|tonight|forecast|new|recent|breaking|current)\b/.test(text)
	);
}

function mentionsCustomTool(text: string): boolean {
	return /\b(newsroom brief|brief generator|producer brief|turn these notes|from these notes|use internal|custom tool)\b/.test(
		text
	);
}
