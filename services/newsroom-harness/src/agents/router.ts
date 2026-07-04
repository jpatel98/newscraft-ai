import { mergeToolBudget, type ToolBudget } from './budget.js';

type ToolMode =
	| 'answer_from_memory'
	| 'direct_answer'
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
	researchResultReader: 'saved_research_reader',
	webSearch: 'openai_web_search',
	urlFetchRead: 'url_fetch_read',
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
			'The request does not identify a source, story, saved update, or concrete newsroom task.',
			[],
			budget,
			'stop immediately and ask for the missing source or story target',
			'a short clarification request'
		);
	}

	if (isGreeting(text)) {
		return decision(
			'answer_from_memory',
			'The request is a greeting and does not require source retrieval.',
			[],
			budget,
			'stop without calling tools',
			'a brief friendly greeting asking what newsroom task to work on'
		);
	}

	if (mentionsNamedOutletCoverageComparison(text)) {
		return decision(
			'web_search',
			'The request compares named outlet coverage, which requires source-backed reporting evidence.',
			[NEWSROOM_TOOL_NAMES.webSearch],
			budget,
			'stop when enough outlet/source evidence exists or the web search budget/provider is unavailable',
			'a sourced comparison of outlet coverage and uncertainty'
		);
	}

	if (isDirectGeneralRequest(text)) {
		return decision(
			'direct_answer',
			'The request is conversational, editorial, analytical, planning, writing, or transformation work that does not require fresh source retrieval.',
			[],
			budget,
			'stop without calling research tools',
			'a direct NewsCraft answer without claiming live source checks'
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

	if (mentionsResearchOutput(text)) {
		return decision(
			'custom_tool',
			'The request asks for saved NewsCraft research output.',
			[NEWSROOM_TOOL_NAMES.researchResultReader],
			budget,
			'stop after the latest relevant research output is found or confirmed unavailable',
			'a concise answer grounded in saved research evidence'
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
	const wantsOfficialOnly = mentionsOfficialOnly(text);
	const wantsExplicitSearch = mentionsExplicitSearch(text);
	const wantsFreshFacts = mentionsFreshFacts(text);
	const wantsVerification = mentionsVerification(text);
	const hasUrl = /https?:\/\//i.test(text);

	if ((wantsCurrentSources || hasUrl) && wantsOtherOutlets) {
		return decision(
			'hybrid_research',
			hasUrl
				? 'The request supplies a direct source URL and asks for broader coverage context.'
				: 'The request needs both primary/source evidence and broader coverage context.',
			[hasUrl ? NEWSROOM_TOOL_NAMES.sourceFeedFetcher : NEWSROOM_TOOL_NAMES.sourceMonitor, NEWSROOM_TOOL_NAMES.webSearch],
			budget,
			'stop after primary/source evidence and broader coverage evidence exist, or a budget/availability limit is hit',
			'a producer-ready answer separating official or primary sources from media reports'
		);
	}

	if (hasUrl) {
		return decision(
			'custom_tool',
			'The request supplies a direct URL, so route through the explicit source fetch path.',
			[NEWSROOM_TOOL_NAMES.sourceFeedFetcher],
			budget,
			'stop after the URL/source fetch returns evidence or a clear limitation',
			'an answer grounded in direct source-fetch evidence'
		);
	}

	if (wantsOfficialOnly && (wantsConfiguredSources || wantsCurrentSources || hasUrl)) {
		return decision(
			'source_monitor',
			'The request asks for official or primary-source-only research.',
			[NEWSROOM_TOOL_NAMES.sourceMonitor, NEWSROOM_TOOL_NAMES.webSearch],
			budget,
			'stop when configured or primary-source evidence is sufficient, or use web search only to locate primary material',
			'a concise primary-source brief with provenance'
		);
	}

	if (wantsConfiguredSources || wantsCurrentSources) {
		return decision(
			'hybrid_research',
			'The request targets current newsroom research; default to broad discovery plus configured-source checks.',
			[NEWSROOM_TOOL_NAMES.sourceMonitor, NEWSROOM_TOOL_NAMES.webSearch],
			budget,
			'stop after configured/source evidence and broader coverage evidence exist, or a budget/availability limit is hit',
			'a sourced brief labeling official or primary sources separately from media reports'
		);
	}

	if (wantsOtherOutlets || wantsExplicitSearch || wantsFreshFacts || wantsVerification) {
		return decision(
			'web_search',
			'The request asks for broad discovery, related coverage, or what other outlets are reporting.',
			[NEWSROOM_TOOL_NAMES.webSearch],
			budget,
			'stop when enough web-search evidence exists or the web search budget/provider is unavailable',
			'a sourced answer summarizing related coverage and uncertainty'
		);
	}

	if (mentionsStableNewsroomGuidance(text)) {
		return decision(
			'answer_from_memory',
			'The request asks for stable newsroom guidance that does not require fresh source retrieval.',
			[],
			budget,
			'stop without calling tools',
			'a direct answer without pretending to have checked live sources'
		);
	}

	if (mentionsCustomTool(text)) {
		return decision(
			'custom_tool',
			'The request can be handled by an internal newsroom tool rather than broad search.',
			[NEWSROOM_TOOL_NAMES.briefGenerator],
			budget,
			'stop after the internal tool returns evidence or a clear limitation',
			'an answer grounded in custom-tool evidence'
		);
	}

	return decision(
		'direct_answer',
		'No research trigger matched; producer chat defaults to a direct assistant answer.',
		[],
		budget,
		'stop without calling research tools',
		'a direct NewsCraft answer without claiming live source checks'
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
	return (
		/^(summarize|check|research|verify|look into|what about|update me|latest)\s*(this|that|it|story)?\??$/.test(text) ||
		/^(what\s+did\s+)?(?:they|he|she|it|that|this)\s+(?:say|mean|do|announce|claim|report)(?:\s+(?:about|on|regarding)\s+(?:it|that|this))?\??$/.test(text) ||
		/^what\s+(?:did|does|are|is)\s+(?:they|he|she|it|that|this)\s+(?:say|mean|doing|about)\??$/.test(text)
	);
}

function isGreeting(text: string): boolean {
	const stripped = text.replace(/^(?:user|assistant|system):\s*/, '').trim();
	return /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|howdy|hiya)[!.? ]*$/.test(stripped);
}

function mentionsBrowserAutomation(text: string): boolean {
	return /\b(browser|browse|click|screenshot|scroll|interactive|dynamic page|javascript-rendered|log in|login|captcha|paywall)\b/.test(
		text
	);
}

function mentionsResearchOutput(text: string): boolean {
	return /\b(research output|saved research(?: update)?|saved update|latest (?:research )?update|last (?:research )?update|previous (?:research )?update|stored report)\b/.test(text);
}

function mentionsPdfOrDocument(text: string): boolean {
	return /\b(pdf|document extractor|extract text|source document|filing|uploaded document)\b/.test(text) || /\.pdf\b/.test(text);
}

function mentionsOtherOutlets(text: string): boolean {
	return /\b(other outlets|media reports|what outlets|coverage elsewhere|related coverage|competitor coverage|reporting about|who else is reporting|broader coverage)\b/.test(
		text
	);
}

function mentionsConfiguredSource(text: string): boolean {
	return /\b(configured source|source monitor|source monitors|monitor list|rss|feed|feeds|watchlist)\b/.test(text);
}

function mentionsCurrentSourceCheck(text: string): boolean {
	return /\b(scan|monitor|release|releases|press release|police|public safety)\b/.test(text);
}

function mentionsOfficialOnly(text: string): boolean {
	return /\b(official only|primary only|first[- ]party only|source of truth only|original source|original sources|press releases only|do not use media|no media reports|verify against official|official sources)\b/.test(
		text
	);
}

function mentionsCustomTool(text: string): boolean {
	return /\b(newsroom brief|brief generator|producer brief|turn these notes|from these notes|use internal|custom tool)\b/.test(
		text
	);
}

function mentionsStableNewsroomGuidance(text: string): boolean {
	return /\b(what is|what's|define|explain|how do i|how should i|best practice|style guidance)\b.*\b(nut graf|lede|inverted pyramid|byline|dateline|embargo|off the record|on background|attribution)\b/.test(
		text
	);
}

function isDirectGeneralRequest(text: string): boolean {
	if (mentionsResearchOutput(text) || mentionsPdfOrDocument(text) || mentionsBrowserAutomation(text)) return false;
	if (mentionsNamedOutletCoverageComparison(text)) return false;
	if (mentionsOtherOutlets(text) || mentionsConfiguredSource(text) || mentionsCurrentSourceCheck(text)) return false;
	if (mentionsOfficialOnly(text) || mentionsCustomTool(text) || /https?:\/\//i.test(text)) return false;
	if (mentionsFreshFacts(text) || mentionsVerification(text) || mentionsExplicitSearch(text)) return false;
	return mentionsConversationalHelp(text) || mentionsWritingPlanningAnalysisOrTransform(text);
}

function mentionsNamedOutletCoverageComparison(text: string): boolean {
	const comparableText = text.replace(/https?:\/\/[^\s)>\]]+/gi, ' ');
	if (!/\b(compare|contrast|analy[sz]e|summari[sz]e|review|break down)\b/.test(comparableText)) return false;
	if (!/\b(coverage|reporting|stories|story|article|articles|outlets?)\b/.test(comparableText)) return false;
	const outletMatches = comparableText.match(/\b(cbc|ctv|global(?: news)?|cp24|citynews|toronto star|the star|globe and mail|national post|reuters|ap|associated press|bbc|cnn|fox news|new york times|washington post|guardian|al jazeera)\b/g);
	if ((outletMatches?.length || 0) >= 2) return true;
	return /\b[a-z0-9.-]+\.(?:com|ca|org|net|news)\b/.test(comparableText);
}

function mentionsConversationalHelp(text: string): boolean {
	return /\b(help me understand|can you explain|explain|teach me|walk me through|brainstorm|think through|give me feedback|what do you think)\b/.test(
		text
	);
}

function mentionsWritingPlanningAnalysisOrTransform(text: string): boolean {
	return /\b(write|draft|rewrite|edit|polish|tighten|turn this into|convert|format|outline|plan|brainstorm|summarize these notes|summarise these notes|analyze this text|analyse this text|compare these|make this clearer|headline|script|email|memo|pitch|rundown|questions to ask|interview questions)\b/.test(
		text
	);
}

function mentionsFreshFacts(text: string): boolean {
	return /\b(latest|current|currently|today|tonight|tomorrow|yesterday|this week|this month|recent|breaking|live|now|update|updates|news|what happened|what's happening|what is happening|who is|who's|who are|when is|where is|result|score|price|prices|weather|schedule|what (?:is|are|was|were) .+ referring to)\b/.test(
		text
	);
}

function mentionsVerification(text: string): boolean {
	return /\b(verify|fact[- ]?check|confirm|source-backed|source backed|with sources|cite|citation|citations|provenance|evidence|reliable sources|according to|is it true|did .* actually)\b/.test(
		text
	);
}

function mentionsExplicitSearch(text: string): boolean {
	return /\b(search|research|look up|look into|find out|browse|google|web|internet|source|sources|outlet|outlets|reporting)\b/.test(
		text
	);
}
