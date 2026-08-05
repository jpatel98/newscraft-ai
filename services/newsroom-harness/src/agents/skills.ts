import type { DocumentContext, ConversationContext, ResearchRequestContract } from '@newscraft/shared';
import { NEWSROOM_TOOL_NAMES } from './router.js';

/**
 * Small, newsroom-specific procedures exposed through progressive disclosure.
 * The loop first sees only the catalog entry; full instructions are included
 * after a decision selects a skill. Skills are read-only procedures and never
 * own memory, scheduling, messaging, or computer-control capabilities.
 */
export type NewsroomSkillId =
	| 'current_news_sweep'
	| 'source_verification'
	| 'coverage_comparison'
	| 'document_grounded'
	| 'newsroom_transformations';

export interface NewsroomSkill {
	id: NewsroomSkillId;
	name: string;
	summary: string;
	when_to_use: string;
	instructions: string;
	read_only_tools: string[];
}

export const NEWSROOM_SKILLS: readonly NewsroomSkill[] = [
	{
		id: 'current_news_sweep',
		name: 'Current-news sweep',
		summary: 'Bounded current-coverage discovery with freshness, source diversity, and visible gaps.',
		when_to_use: 'Use for latest, current, today, breaking, briefing, roundup, or assignment-desk requests.',
		instructions:
			'Find a small set of distinct, directly relevant stories in the request-scoped freshness window. Start with configured or official sources when relevant, then use independent coverage only to fill real gaps. Follow promising indexes to readable article or official pages. Stop when new results are repetitive, the request contract is satisfied, or the remaining gap is not likely to improve materially.',
		read_only_tools: [
			NEWSROOM_TOOL_NAMES.sourceMonitor,
			NEWSROOM_TOOL_NAMES.sourceFeedFetcher,
			NEWSROOM_TOOL_NAMES.webSearch,
			NEWSROOM_TOOL_NAMES.urlFetchRead
		]
	},
	{
		id: 'source_verification',
		name: 'Source verification',
		summary: 'Read the source directly, check provenance, and separate confirmed claims from leads.',
		when_to_use: 'Use for verify, fact-check, confirm, status, direct URLs, or primary-source requests.',
		instructions:
			'Read the supplied or discovered source directly when possible. Preserve the source URL, page role, publication or event time, supporting excerpt, and limitations. Use a second source only when the contract asks for corroboration or the first source leaves a material claim unresolved. Never promote a snippet, hub, social post, or undated lead into a confirmed claim.',
		read_only_tools: [
			NEWSROOM_TOOL_NAMES.urlFetchRead,
			NEWSROOM_TOOL_NAMES.sourceMonitor,
			NEWSROOM_TOOL_NAMES.webSearch
		]
	},
	{
		id: 'coverage_comparison',
		name: 'Coverage comparison',
		summary: 'Compare named or independent coverage without merging disagreement or duplicating stories.',
		when_to_use: 'Use when the producer asks what other outlets report, compares publishers, or requests corroboration.',
		instructions:
			'Collect direct article-level evidence for the requested publishers or independent coverage lanes. Group matching stories in the evidence ledger, retain meaningful disagreements, and state which details are confirmed by which source. Do not satisfy a named-outlet request with a republished copy or a publisher landing page.',
		read_only_tools: [NEWSROOM_TOOL_NAMES.webSearch, NEWSROOM_TOOL_NAMES.urlFetchRead]
	},
	{
		id: 'document_grounded',
		name: 'Document-grounded work',
		summary: 'Use attached document pages as private evidence and keep external corroboration explicit.',
		when_to_use: 'Use for attached PDFs, uploaded documents, filings, or pasted source text.',
		instructions:
			'Read only the supplied document evidence unless the latest request explicitly asks for external verification. Keep page-level provenance and distinguish user-provided material from independently verified sources. Never leak private document text into unrelated research, durable memory, or a different conversation.',
		read_only_tools: [NEWSROOM_TOOL_NAMES.pdfTextExtractor]
	},
	{
		id: 'newsroom_transformations',
		name: 'Newsroom transformations',
		summary: 'Transform already supplied or inherited evidence into producer-ready copy without fresh claims.',
		when_to_use: 'Use for headline, OC/VO, producer brief, rewrite, table, outline, or other transformation requests.',
		instructions:
			'Use only the supplied notes, conversation evidence, or attached document evidence unless the current request explicitly requires fresh research. Preserve attribution, uncertainty, and citation markers. A transformation is a final synthesis action, not permission to invent facts or silently refresh stale evidence.',
		read_only_tools: []
	}
];

export interface SkillDiscoveryInput {
	request: string;
	contract?: ResearchRequestContract;
	conversationContext?: ConversationContext;
	documents?: DocumentContext[];
}

/** Return the smallest relevant skill set in stable order. */
export function discoverNewsroomSkills(input: SkillDiscoveryInput): NewsroomSkill[] {
	const request = input.request.toLowerCase();
	const selected = new Set<NewsroomSkillId>();
	const current = Boolean(
		input.contract?.temporalWindow.kind === 'current' ||
		input.contract?.temporalWindow.kind === 'relative' ||
		/\b(latest|current|today|tonight|breaking|newest|briefing|roundup|headlines?)\b/.test(request)
	);
	const verify = Boolean(/\b(verify|fact[- ]?check|confirm|status|source of truth|official only|primary only)\b/.test(request));
	const compare = Boolean(/\b(compare|contrast|other outlets?|broader coverage|corroborat|independent coverage|who else)\b/.test(request));
	const transform = input.conversationContext?.intent === 'transform' ||
		/\b(headline|lede|rewrite|oc\/?vo|brief|outline|table|transform|turn .* into)\b/.test(request);

	if (input.documents?.length) selected.add('document_grounded');
	if (current) selected.add('current_news_sweep');
	if (verify || /https?:\/\//i.test(request)) selected.add('source_verification');
	if (compare) selected.add('coverage_comparison');
	if (transform) selected.add('newsroom_transformations');
	if (!selected.size) {
		if (input.conversationContext?.currentTurn?.researchRequired !== false) selected.add('current_news_sweep');
		else selected.add('newsroom_transformations');
	}

	return NEWSROOM_SKILLS.filter((skill) => selected.has(skill.id));
}

export function skillCatalog(skills: readonly NewsroomSkill[]): string {
	return skills
		.map((skill) => `- ${skill.id}: ${skill.summary} When: ${skill.when_to_use}`)
		.join('\n');
}

export function skillInstructions(skillId: string | undefined, skills: readonly NewsroomSkill[]): string {
	if (!skillId) return '';
	return skills.find((skill) => skill.id === skillId)?.instructions || '';
}

export function skillForTool(toolName: string, skills: readonly NewsroomSkill[]): NewsroomSkill | undefined {
	return skills.find((skill) => skill.read_only_tools.includes(toolName));
}
