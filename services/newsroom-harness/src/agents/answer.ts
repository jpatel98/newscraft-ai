import type { ToolBudgetSnapshot } from './budget.js';
import { assessEvidenceQuality, isUsableEvidence, type EvidenceObject } from './evidence.js';
import type { RouteDecision } from './router.js';

export interface AnswerGenerationInput {
	prompt: string;
	decision: RouteDecision;
	evidence: EvidenceObject[];
	limitations: string[];
	budget: ToolBudgetSnapshot;
	toolAnswers?: string[];
	outputStyle?: 'report' | 'chat';
}

export function generateFinalAnswer(input: AnswerGenerationInput): string {
	const sortedEvidence = sortEvidenceForPrompt(input.prompt, input.evidence);
	const evidence = sortedEvidence.filter(isUsableEvidence);
	const unusableEvidence = sortedEvidence.filter((item) => !isUsableEvidence(item));
	if (input.decision.selected_mode === 'clarification_needed') {
		return 'I need a specific source, story, document, or research update to check before I can answer cleanly.';
	}
	if (input.decision.selected_mode === 'answer_from_memory') {
		return answerFromMemory(input.prompt);
	}
	if (!evidence.length && input.toolAnswers?.length) {
		const answer = input.toolAnswers.filter((item) => item.trim()).join('\n\n');
		const caveats = publicCaveatsFor(input.prompt, evidence, unusableEvidence, input.limitations, {
			noUsableEvidence: true
		});
		const visibleCaveats = input.outputStyle === 'chat' ? chatToolAnswerCaveats(input.prompt, caveats) : caveats;
		const guarded = appendCaveats(input.outputStyle === 'chat' ? formatChatToolAnswer(input.prompt, answer) : answer.trim(), visibleCaveats);
		return input.outputStyle === 'chat' ? cleanVisibleChatOutput(guarded, input.prompt) : guarded;
	}
	if (!evidence.length) {
		if (input.outputStyle === 'chat') return chatNoLead(unusableEvidence, input.limitations);
		return noPublishableLeadReport(unusableEvidence, input.limitations);
	}
	if (input.outputStyle === 'chat') {
		return chatAnswer(input.prompt, evidence, unusableEvidence, input.limitations, input.toolAnswers || []);
	}

	const briefItems = evidence.slice(0, 5).map((item) => briefItemFor(item));
	const lead = leadParagraph(input.prompt, evidence, briefItems);
	const listedSources = evidence.slice(0, 12);
	const sourceNotes = [
		...listedSources.map((item) => {
			const note = sourceNoteFor(item);
			return `- ${formatSourceLink(item)} - ${kindLabel(item)}; ${publicationDateLabel(item)}.${note ? ` ${note}` : ''}`;
		}),
		...(evidence.length > listedSources.length
			? [`- ${evidence.length - listedSources.length} additional usable sources were recorded and omitted from this compact brief.`]
			: []),
		...sourceIssueNotes(unusableEvidence, input.limitations)
	];
	const uncertaintyNotes = uncertaintyNotesFor(input.prompt, evidence, unusableEvidence);

	return [
		'## Summary',
		lead,
		'',
		'## Sources',
		sourceNotes.join('\n'),
		'',
		'## Uncertainty',
		uncertaintyNotes.join('\n')
	].join('\n');
}

function chatAnswer(
	prompt: string,
	evidence: EvidenceObject[],
	unusableEvidence: EvidenceObject[],
	limitations: string[],
	toolAnswers: string[]
): string {
	const freshest = evidence[0];
	const rawToolAnswer = toolAnswers.find((item) => item.trim());
	const answer = rawToolAnswer ? formatChatToolAnswer(prompt, rawToolAnswer) : summaryFor(freshest, 720);
	const caveats = publicCaveatsFor(prompt, evidence, unusableEvidence, limitations, { noUsableEvidence: false });
	return appendCaveats(answer, caveats);
}

function formatChatToolAnswer(prompt: string, answer: string): string {
	return cleanVisibleChatOutput(answer, prompt);
}

function chatToolAnswerCaveats(prompt: string, caveats: string[]): string[] {
	if (needsExplicitVerificationCaveat(prompt)) return caveats;
	return caveats.filter((item) => !/^I could not find reliable sources confirming this\b/i.test(item));
}

export function cleanVisibleChatOutput(answer: string, prompt = ''): string {
	const cleaned = cleanChatToolAnswer(answer);
	if (wantsTable(prompt)) return compactChatText(cleaned, 4000);
	return polishedChatText(cleaned, 4000);
}

function wantsTable(prompt: string): boolean {
	return /\b(table|tabular|rows?|columns?)\b/i.test(prompt);
}

function chatNoLead(unusableEvidence: EvidenceObject[], limitations: string[] = []): string {
	const notes = sourceIssueNotes(unusableEvidence).slice(0, 3);
	const caveats = publicCaveatsFor('', [], unusableEvidence, limitations, { noUsableEvidence: true });
	return [
		caveats[0] || 'I could not find reliable sources confirming this.',
		notes.length ? `Skipped sources: ${notes.join(' ')}` : '',
		'Try again with a specific outlet/source, or rerun when the source is readable.'
	]
		.filter(Boolean)
		.join('\n\n');
}

function answerFromMemory(prompt: string): string {
	const normalized = prompt.toLowerCase().replace(/^(?:user|assistant|system):\s*/, '').trim();
	if (/^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|howdy|hiya)[!.? ]*$/.test(normalized)) {
		return 'Hi. What should NewsCraft work on?';
	}
	if (/\bnut graf\b/.test(normalized)) {
		return 'A nut graf is the early paragraph that tells the audience what the story is really about and why it matters. It should clarify the stakes, context, and reason to keep reading without overstating facts.';
	}
	if (/\bproducer brief|newsroom brief\b/.test(normalized)) {
		return 'A producer-ready brief should state what happened, what is new, why it matters, what is confirmed, what still needs checking, and which sources support each point.';
	}
	return 'This appears to be stable newsroom guidance rather than a live-source request. I would answer from established practice, and I would not claim to have checked current sources unless a tool run is routed.';
}

interface BriefItem {
	evidence: EvidenceObject;
	title: string;
	source: string;
	detail: string;
}

function leadParagraph(prompt: string, evidence: EvidenceObject[], briefItems: BriefItem[]): string {
	const official = evidence.filter((item) => item.source_kind === 'official' || item.source_kind === 'primary');
	const media = evidence.filter((item) => item.source_kind === 'media_report');
	const newest = evidence[0];
	const itemCount = briefItems.length;
	const base =
		itemCount > 1
			? `This research update found ${itemCount} usable source${itemCount === 1 ? '' : 's'}. The strongest source material is listed below with attribution.`
			: `This research update found one usable source: ${briefItems[0]?.title || sourceDisplayTitle(newest, 120)}.`;
	const latestFraming = latestAvailableFraming(prompt, newest);
	const sourceFraming =
		official.length && media.length
			? `The gathered evidence includes ${official.length} official or primary source${official.length === 1 ? '' : 's'} and ${media.length} media report${media.length === 1 ? '' : 's'}.`
			: official.length
				? `The gathered evidence is led by official or primary source material.`
				: media.length
					? `The gathered evidence is based on media reports and should be checked against primary-source material before you rely on it.`
					: `The gathered evidence should be treated as preliminary.`;
	const changed = /\b(latest|new|changed|update|today|recent)\b/i.test(prompt)
		? ` Latest source material is listed below.`
		: '';
	return `${base}\n\n${[latestFraming, sourceFraming].filter(Boolean).join(' ')}${changed}`;
}

function uncertaintyNotesFor(prompt: string, evidence: EvidenceObject[], unusableEvidence: EvidenceObject[]): string[] {
	const notes: string[] = [];
	const officialCount = evidence.filter((item) => item.source_kind === 'official' || item.source_kind === 'primary').length;
	const mediaCount = evidence.filter((item) => item.source_kind === 'media_report').length;
	if (officialCount) notes.push(`- Official or primary source material is available: ${officialCount}.`);
	if (mediaCount) notes.push(`- Secondary or media source material is available: ${mediaCount}; attribute outlet reporting separately from official statements.`);
	if (detectPoliceLegalTask(prompt)) {
		notes.push(
			'- Police/legal caution: distinguish allegations, arrests, charges, and convictions. Do not imply guilt unless a conviction is documented.'
		);
	}
	const conflicts = detectConflicts(evidence);
	notes.push(
		conflicts.length
			? `- Potential conflicts to resolve: ${conflicts.join('; ')}.`
			: '- No conflicting claims were apparent in the usable source notes.'
	);
	if (unusableEvidence.length) notes.push('- Some configured sources could not be read and were not used as evidence.');
	return notes.length ? notes : ['- No additional uncertainty notes were generated.'];
}

function detectPoliceLegalTask(prompt: string): boolean {
	return /\b(police|court|arrest|charged|charges|convicted|conviction|alleged|suspect|victim|public safety)\b/i.test(
		prompt
	);
}

function detectConflicts(evidence: EvidenceObject[]): string[] {
	const combined = evidence.map((item) => `${item.title} ${item.summary}`).join(' ').toLowerCase();
	const conflicts: string[] = [];
	if (combined.includes('denied') && combined.includes('confirmed')) conflicts.push('confirmed and denied claims both appear');
	if (combined.includes('no injuries') && combined.includes('injuries')) conflicts.push('injury details may differ');
	return conflicts;
}

function sortEvidenceForPrompt(prompt: string, evidence: EvidenceObject[]): EvidenceObject[] {
	const currentRequest = /\b(latest|today|new|recent|breaking|current|update|updates)\b/i.test(prompt);
	return [...evidence].sort((left, right) =>
		currentRequest ? compareEvidenceRecency(left, right) : compareEvidencePriority(left, right)
	);
}

function compareEvidenceRecency(left: EvidenceObject, right: EvidenceObject): number {
	const leftTime = evidenceTimeMs(left);
	const rightTime = evidenceTimeMs(right);
	if (leftTime !== rightTime) return rightTime - leftTime;
	return sourcePriority(left) - sourcePriority(right);
}

function compareEvidencePriority(left: EvidenceObject, right: EvidenceObject): number {
	const leftPriority = sourcePriority(left);
	const rightPriority = sourcePriority(right);
	if (leftPriority !== rightPriority) return leftPriority - rightPriority;
	return evidenceTimeMs(right) - evidenceTimeMs(left);
}

function sourcePriority(item: EvidenceObject): number {
	const priority = { official: 0, primary: 1, internal: 2, media_report: 3, unknown: 4 };
	return priority[item.source_kind || 'unknown'];
}

function evidenceTimeMs(item: EvidenceObject): number {
	const parsed = Date.parse(item.published_at || '');
	return Number.isFinite(parsed) ? parsed : 0;
}

function kindLabel(item: EvidenceObject): string {
	if (item.source_kind === 'official') return 'official source';
	if (item.source_kind === 'primary') return 'primary source';
	if (item.source_kind === 'media_report') return 'media report';
	if (item.source_kind === 'internal') return 'internal NewsCraft source';
	return 'source';
}

function formatSourceLink(item: EvidenceObject): string {
	const label = sourceDisplayTitle(item, 90).replace(/\]/g, ')');
	if (item.source_url.startsWith('newsroom://') || item.source_url === 'about:blank') {
		return `${label} (${item.source_url})`;
	}
	return `[${label}](${item.source_url})`;
}

function briefItemFor(item: EvidenceObject): BriefItem {
	const title = sourceDisplayTitle(item, 110);
	const source = formatSourceLink(item);
	const detail = cleanBriefDetail(item, title);
	return { evidence: item, title, source, detail };
}

function sourceNoteFor(item: EvidenceObject): string {
	const title = sourceDisplayTitle(item, 110);
	return cleanBriefDetail(item, title, 220);
}

function cleanBriefDetail(item: EvidenceObject, title: string, maxLength = 180): string {
	const raw = item.summary || firstUsefulSentence(item.extracted_text) || '';
	const cleaned = compactText(raw, maxLength);
	if (!cleaned) return '';
	if (sameNormalized(cleaned, title)) return '';
	if (looksLikeHeadlineBlob(cleaned)) return '';
	return cleaned;
}

function firstUsefulSentence(value: string): string {
	return value
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.find((sentence) => sentence.length >= 40 && !looksLikeHeadlineBlob(sentence)) || '';
}

function looksLikeHeadlineBlob(value: string): boolean {
	const cleaned = value.toLowerCase();
	const urlish = (cleaned.match(/\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:ca|com|org|net)\/)/g) || []).length;
	const dateReadMarkers = (cleaned.match(/\b(?:mins?|hours?|min read|updated|breaking|subscribe|skip to|sign in)\b/g) || [])
		.length;
	const sentenceMarks = (value.match(/[.!?]/g) || []).length;
	return urlish >= 1 || dateReadMarkers >= 2 || (value.length > 180 && sentenceMarks <= 1);
}

function sameNormalized(left: string, right: string): boolean {
	const normalizedLeft = normalizeComparable(left);
	const normalizedRight = normalizeComparable(right);
	return Boolean(normalizedLeft && normalizedRight && (normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight)));
}

function normalizeComparable(value: string): string {
	return value
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function summaryFor(item: EvidenceObject, maxLength = 260): string {
	return compactText(item.summary || item.extracted_text || item.title, maxLength);
}

function sourceDisplayTitle(item: EvidenceObject, maxLength: number): string {
	const title = item.title.trim();
	if (looksUrlLike(title) || title === item.source_url) return compactUrlLabel(item.source_url, maxLength);
	return compactText(title, maxLength);
}

function compactUrlLabel(value: string, maxLength: number): string {
	try {
		const url = new URL(value);
		const path = url.pathname.replace(/\/$/, '');
		const label = `${url.hostname.replace(/^www\./, '')}${path && path !== '/' ? path : ''}`;
		if (label.length <= maxLength) return label;
		return `${label.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
	} catch {
		return compactText(value, maxLength);
	}
}

function looksUrlLike(value: string): boolean {
	return /^https?:\/\//i.test(value) || /^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(value);
}

function latestAvailableFraming(prompt: string, item: EvidenceObject): string {
	if (!/\b(latest|today|new|recent|breaking|current|update|updates)\b/i.test(prompt)) return '';
	if (!item.published_at) {
		return 'No usable source in this run included a publication date; treat the date as unknown and verify recency before use.';
	}
	return `The freshest usable source found in this run was published ${item.published_at}; treat this as the latest available result, not proof that nothing newer exists.`;
}

function publicationDateLabel(item: EvidenceObject): string {
	return item.published_at ? `published ${item.published_at}` : 'publication date not found';
}

function compactText(value: string, maxLength: number): string {
	const cleaned = value
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/[*_~>`#]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function compactChatText(value: string, maxLength: number): string {
	const cleaned = value
		.replace(/```(?:markdown|md|text)?\n?/gi, '')
		.replace(/```/g, '')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/__([^_]+)__/g, '$1')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function cleanChatToolAnswer(value: string): string {
	return normalizeChatAnswerWhitespace(repairInlineStoryLines(stripCitationChatter(stripSourceSections(value))));
}

function stripSourceSections(value: string): string {
	return value
		.replace(
			/(?:^|\n)\s*(?:#{1,6}\s*)?(?:sources?|references?|citations?)\b\s*:?\s*[\s\S]*$/i,
			''
		)
		.replace(/(?:^|\n)\s*(?:[-*]\s*)?\[[^\]]+\]\(https?:\/\/[^)]+\)[^\n]*/gi, '');
}

function stripCitationChatter(value: string): string {
	return value
		.replace(
			/(?:^|\n)\s*If you(?:'|’)d like,\s*(?:the )?next step can be[\s\S]*?(?=\n{2,}|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*(?:Would you like|Do you want) (?:me )?to[\s\S]*?(?=\n{2,}|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*I could not find reliable\s*$/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*Link extraction was incomplete for this web search result; verify before relying on it\.\s*/gi,
			'\n'
		)
		.replace(/\bPosted times?:\s*[\s\S]*?(?=\s+(?:Additional confirmations?|AP write[- ]?up|Canadian Press version|Sources?:)\b|$)/gi, '')
		.replace(/\bAdditional confirmations?:\s*[\s\S]*$/i, '')
		.replace(/\bAP write[- ]?up carried by\s*[\s\S]*$/i, '')
		.replace(/\bCanadian Press version carried by\s*[\s\S]*$/i, '')
		.replace(/\bIt is based on media\/search results and should be checked against a primary source before publication\.?/gi, '')
		.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, '$1')
		.replace(/https?:\/\/\S+/gi, '')
		.replace(/\s+\((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^)]*)?\)/gi, '');
}

function normalizeChatAnswerWhitespace(value: string): string {
	return value
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/\s+([,.;:!?])/g, '$1')
		.trim();
}

function repairInlineStoryLines(value: string): string {
	return value
		.replace(/\s*,?\s*ordered by freshness:?\s*/gi, ':\n')
		.replace(/:\s+-\s+/g, ':\n- ')
		.replace(
			/\s+-\s+(?=(?:Today|Yesterday|Latest|This morning|This afternoon|This evening|[A-Z][A-Za-z0-9'’$,.&/ ]{2,80})\s+[—–-]\s+)/g,
			'\n- '
		)
		.replace(/^- (Today|Yesterday|Latest|This morning|This afternoon|This evening)\s+[—–-]\s+/gim, '$1: ')
		.replace(/^- Bold:\s*([^—–:\n]{2,100})\s+[—–-]\s+/gim, '$1: ')
		.replace(/^- ([A-Z][^:\n]{2,80})\s+[—–-]\s+/gm, '$1: ');
}

function polishedChatText(value: string, maxLength: number): string {
	const cleaned = value
		.replace(/```(?:markdown|md|text)?\n?/gi, '')
		.replace(/```/g, '')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/__([^_]+)__/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/^Bold:\s*/gim, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return truncateTextAtBoundary(cleaned, maxLength);
}

function truncateTextAtBoundary(value: string, maxLength: number): string {
	const slice = value.slice(0, maxLength);
	const paragraph = slice.lastIndexOf('\n\n');
	const line = slice.lastIndexOf('\n');
	const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
	const boundary = Math.max(paragraph, line, sentence);
	const trimmed = slice.slice(0, boundary > maxLength * 0.55 ? boundary : maxLength).trim();
	return `${trimmed}…`;
}

function noPublishableLeadReport(unusableEvidence: EvidenceObject[], limitations: string[] = []): string {
	const sourceNotes = sourceIssueNotes(unusableEvidence, limitations);
	return [
		'## Summary',
		[
			'No research update was saved from this run because no usable source material was available.',
			publicCaveatsFor('', [], unusableEvidence, limitations, { noUsableEvidence: true })[0]
		]
			.filter(Boolean)
			.join(' '),
		'',
		'## Sources',
		sourceNotes.length ? sourceNotes.join('\n') : '- No readable source material was available from this run.',
		'',
		'## Uncertainty',
		'- Re-run after the source is readable, attach a source feed, or check the story against a readable primary or reliable secondary source.'
	].join('\n');
}

function sourceIssueNotes(evidence: EvidenceObject[], limitations: string[] = []): string[] {
	const seen = new Set<string>();
	const notes: string[] = [];
	for (const item of evidence) {
		const quality = assessEvidenceQuality(item);
		if (quality.usable) continue;
		const label = publicIssueLabel(item);
		const note = quality.publicNote || 'Source did not return usable story text during this run.';
		const key = `${label}\n${note}`;
		if (seen.has(key)) continue;
		seen.add(key);
		notes.push(`- ${label}: ${note} It was not used as evidence.`);
	}
	for (const limitation of limitations) {
		const note = publicLimitationNote(limitation);
		if (!note || seen.has(note)) continue;
		seen.add(note);
		notes.push(`- ${note}`);
	}
	return notes;
}

function publicCaveatsFor(
	prompt: string,
	evidence: EvidenceObject[],
	unusableEvidence: EvidenceObject[],
	limitations: string[],
	options: { noUsableEvidence: boolean }
): string[] {
	const caveats: string[] = [];
	const combinedLimitations = [...limitations, ...unusableEvidence.flatMap((item) => item.limitations)];
	const providerConfigurationLimitation = combinedLimitations
		.map(providerUnavailableLimitation)
		.find((item): item is string => Boolean(item));
	const blocked = combinedLimitations.some((item) => /paywall|subscription|login|captcha|blocked|unavailable|access denied|forbidden|could not be read/i.test(item));
	if (options.noUsableEvidence) {
		if (providerConfigurationLimitation) caveats.push(providerConfigurationLimitation);
		else {
			caveats.push(
				blocked
					? 'I could not find reliable sources confirming this because one or more sources were blocked, paywalled, unavailable, or could not be read.'
					: 'I could not find reliable sources confirming this in the gathered material.'
			);
		}
		return caveats;
	}
	if (providerConfigurationLimitation) caveats.push(providerConfigurationLimitation);

	if (blocked || unusableEvidence.length) {
		caveats.push('Some candidate sources were blocked, paywalled, unavailable, or could not be read, and were not used as evidence.');
	}
	if (needsPrimaryConfirmation(prompt, evidence)) {
		caveats.push('I could not confirm this from a readable official or primary source in the gathered material; verify before relying on it.');
	}
	if (evidence.length && evidence.every((item) => item.confidence < 0.55)) {
		caveats.push('The available source material is weak; treat this as unconfirmed until stronger sources are available.');
	}
	return caveats;
}

function needsPrimaryConfirmation(prompt: string, evidence: EvidenceObject[]): boolean {
	if (!needsExplicitVerificationCaveat(prompt)) return false;
	return !evidence.some((item) => item.source_kind === 'official' || item.source_kind === 'primary');
}

function needsExplicitVerificationCaveat(prompt: string): boolean {
	return /\b(verify|confirm|official|primary|source of truth|what .* officially said)\b/i.test(prompt);
}

function appendCaveats(answer: string, caveats: string[]): string {
	const cleaned = answer.trim();
	const unique = caveats.filter((item, index) => item && caveats.indexOf(item) === index);
	if (!unique.length) return cleaned;
	const lower = cleaned.toLowerCase();
	const missing = unique.filter((item) => !lower.includes(item.toLowerCase()));
	return [cleaned, ...missing].filter(Boolean).join('\n\n');
}

function publicLimitationNote(value: string): string {
	const providerUnavailable = providerUnavailableLimitation(value);
	if (providerUnavailable) return providerUnavailable;
	if (/paywall|subscription|login|captcha|blocked|access denied|forbidden|could not be read|unavailable/i.test(value)) {
		return 'A candidate source was blocked, paywalled, unavailable, or could not be read. It was not used as evidence.';
	}
	if (/no usable|no cited sources|no readable|no .*source/i.test(value)) {
		return 'No usable source material was available from one attempted source.';
	}
	return '';
}

function providerUnavailableLimitation(value: string): string | null {
	const match = value.match(
		/^\s*(openai|perplexity)\s+web_search is not configured because\s+([A-Z_]+)\s+is missing\.?$/i
	);
	if (!match) return null;
	const normalizedProvider = match[1].toLowerCase() === 'openai' ? 'OpenAI' : 'Perplexity';
	const apiKeyName = match[2].toUpperCase();
	if (!/OPENAI_API_KEY|PERPLEXITY_API_KEY/.test(apiKeyName)) return null;
	return `The configured research provider (${normalizedProvider}) is unavailable because ${apiKeyName} is not configured.`;
}

function publicIssueLabel(item: EvidenceObject): string {
	if (item.source_name && item.source_name !== item.title) return item.source_name;
	if (item.source_url && item.source_url !== 'about:blank') {
		try {
			return new URL(item.source_url).hostname.replace(/^www\./, '');
		} catch {
			return item.source_url;
		}
	}
	return 'Configured source';
}
