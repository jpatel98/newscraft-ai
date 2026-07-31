import type { ToolBudgetSnapshot } from './budget.js';
import type { ConversationContext } from '@newscraft/shared';
import {
	assessEvidenceQuality,
	isUsableEvidence,
	type EvidenceObject,
	type EvidenceSourceKind
} from './evidence.js';
import type { RouteDecision } from './router.js';

export interface AnswerGenerationInput {
	prompt: string;
	decision: RouteDecision;
	evidence: EvidenceObject[];
	limitations: string[];
	budget: ToolBudgetSnapshot;
	toolAnswers?: string[];
	outputStyle?: 'report' | 'chat';
	conversationContext?: ConversationContext;
	researchStepCount?: number;
}

export function enforceFinalCitationIntegrity(answer: string, evidence: EvidenceObject[]): string {
	const byNumber = new Map<number, EvidenceObject[]>();
	for (const item of evidence) {
		if (!item.citation_number) continue;
		byNumber.set(item.citation_number, [...(byNumber.get(item.citation_number) || []), item]);
	}
	const valid = new Set(
		[...byNumber.entries()].filter(([, items]) => items.length === 1).map(([number]) => number)
	);
	const guarded = answer
		.split('\n')
		.filter((line) => {
			const markers = Array.from(line.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]));
			return !markers.length || markers.every((number) => valid.has(number));
		})
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	const visible = Array.from(new Set(Array.from(guarded.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]))));
	if (!visible.length) return guarded;
	const cited = visible.map((number) => byNumber.get(number)?.[0]).filter((item): item is EvidenceObject => Boolean(item));
	const uncited = evidence.filter((item) => !cited.includes(item));
	const ordered = [...cited, ...uncited];
	const remap = new Map<number, number>();
	for (const [index, item] of ordered.entries()) {
		if (item.citation_number && !remap.has(item.citation_number)) remap.set(item.citation_number, index + 1);
		item.citation_number = index + 1;
	}
	evidence.splice(0, evidence.length, ...ordered);
	return guarded.replace(/\[(\d+)\]/g, (_marker, raw: string) => `[${remap.get(Number(raw))}]`);
}

export function generateFinalAnswer(input: AnswerGenerationInput): string {
	const answerEvidence =
		input.outputStyle === 'chat' ? withImplicitCitationNumbers(input.evidence) : input.evidence;
	const sortedEvidence = answerEvidence.some((item) => item.temporal_scope)
		? answerEvidence
		: sortEvidenceForPrompt(input.prompt, answerEvidence);
	const evidence = sortedEvidence.filter(isUsableEvidence);
	const unusableEvidence = sortedEvidence.filter((item) => !isUsableEvidence(item));
	if (input.decision.selected_mode === 'clarification_needed') {
		return 'I need a specific source, story, document, or research update to check before I can answer cleanly.';
	}
	if (input.decision.selected_mode === 'answer_from_memory') {
		return answerFromMemory(input.prompt);
	}
	if (input.decision.selected_mode === 'direct_answer') {
		return directAnswerFallback(input.prompt);
	}
	if (!evidence.length && input.toolAnswers?.length) {
		const answer = input.toolAnswers
			.filter((item) => item.trim())
			.join('\n\n')
			.replace(/\s*\[\d+\]/g, '');
		const caveats = publicCaveatsFor(input.prompt, evidence, unusableEvidence, input.limitations, {
			noUsableEvidence: true
		});
		const visibleCaveats = input.outputStyle === 'chat' ? chatToolAnswerCaveats(input.prompt, caveats) : caveats;
		const formattedAnswer =
			input.outputStyle === 'chat'
				? `**Unverified lead from the search**\n\n${formatChatToolAnswer(input.prompt, answer)}`
				: answer.trim();
		const guarded = appendCaveats(formattedAnswer, visibleCaveats);
		return input.outputStyle === 'chat' ? cleanVisibleChatOutput(guarded, input.prompt) : guarded;
	}
	if (!evidence.length) {
		if (input.outputStyle === 'chat') return chatNoLead(unusableEvidence, input.limitations);
		return noPublishableLeadReport(unusableEvidence, input.limitations);
	}
	if (input.outputStyle === 'chat') {
		return chatAnswer(
			input.prompt,
			evidence,
			unusableEvidence,
			input.limitations,
			input.toolAnswers || [],
			input.conversationContext,
			input.researchStepCount
		);
	}

	const briefItems = evidence.map((item) => briefItemFor(item));
	const lead = leadParagraph(input.prompt, evidence, briefItems);
	const sourceNotes = [
		...evidence.map((item) => {
			const note = sourceNoteFor(item);
			return `- ${formatSourceLink(item)} - ${kindLabel(item)}; ${publicationDateLabel(item)}.${note ? ` ${note}` : ''}`;
		}),
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
	toolAnswers: string[],
	conversationContext?: ConversationContext,
	researchStepCount = toolAnswers.length
): string {
	const documentEvidence = evidence.filter((item) => item.source_kind === 'user_document');
	const externalEvidence = evidence.filter((item) => item.source_kind !== 'user_document');
	const singleToolAnswer = researchStepCount === 1 && toolAnswers.length === 1 ? toolAnswers[0] : '';
	const answer = singleToolAnswer
		? formatChatToolAnswer(prompt, singleToolAnswer)
		: documentEvidence.length && !externalEvidence.length
			? documentChatAnswer(documentEvidence, prompt)
			: groundedEvidenceChatAnswer(prompt, externalEvidence.length ? externalEvidence : evidence);
	const caveats = publicCaveatsFor(prompt, evidence, unusableEvidence, limitations, { noUsableEvidence: false });
	const publicationDate = publicationDateAnswer(prompt, evidence);
	return appendCaveats([answer, publicationDate].filter(Boolean).join('\n\n'), caveats);
}

function publicationDateAnswer(prompt: string, evidence: EvidenceObject[]): string {
	if (!/\b(?:when (?:was|were) .*published|publication date|published when)\b/i.test(prompt)) return '';
	const dated = evidence.find((item) => item.published_at);
	return dated ? `Publication date: ${dated.published_at}.` : 'Publication date: Date unknown.';
}

function groundedEvidenceChatAnswer(
	prompt: string,
	evidence: EvidenceObject[]
): string {
	const conflict = /\b(?:verify|fact[- ]?check|confirm|is it true|status|active|in effect)\b/i.test(prompt)
		? conflictingEvidenceStatement(evidence)
		: '';
	if (conflict) return conflict;

	const statements = evidence
		.map((item) => {
			const statement = completeEvidenceStatement(item);
			if (!statement) return '';
			const marker = item.citation_number ? ` [${item.citation_number}]` : '';
			const date = item.event_at || item.published_at;
			const dateLabel = date ? new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(date)) : '';
			const fallback = item.temporal_scope === 'fallback' ? 'Earlier (last 24 hours) - ' : '';
			return `${fallback}${dateLabel ? `${dateLabel}: ` : ''}${statement}${marker}`;
		})
		.filter(Boolean)
		.slice(0, 6);
	if (!statements.length) {
		return "I couldn't verify a complete claim from the remaining topic- and date-matched source text.";
	}
	if (statements.length === 1) return statements[0];
	return ['**Latest producer roundup**', '', ...statements.map((statement) => `- ${statement}`)].join('\n');
}

function conflictingEvidenceStatement(evidence: EvidenceObject[]): string {
	if (evidence.length < 2) return '';
	const negative = evidence.find((item) =>
		/\b(?:no|not|never|denied|disputed|false|incorrect|did not|has not|have not|cannot|can't)\b/i.test(
			`${item.summary} ${item.extracted_text}`
		)
	);
	const affirmative = evidence.find(
		(item) =>
			item !== negative &&
			!/\b(?:no|not|never|denied|disputed|false|incorrect|did not|has not|have not|cannot|can't)\b/i.test(
				`${item.summary} ${item.extracted_text}`
			)
	);
	if (!negative || !affirmative) return '';
	const negativeClaim = completeEvidenceStatement(negative);
	const affirmativeClaim = completeEvidenceStatement(affirmative);
	if (!negativeClaim || !affirmativeClaim) return '';
	const negativeMarker = negative.citation_number ? ` [${negative.citation_number}]` : '';
	const affirmativeMarker = affirmative.citation_number ? ` [${affirmative.citation_number}]` : '';
	return [
		'**The available sources conflict, so this remains uncertain.**',
		'',
		`- ${affirmativeClaim}${affirmativeMarker}`,
		`- ${negativeClaim}${negativeMarker}`
	].join('\n');
}

function completeEvidenceStatement(item: EvidenceObject): string {
	const candidate = compactText(item.summary || item.extracted_text || '', 720)
		.replace(/^\([a-z0-9.-]+\)\s*/i, '')
		.replace(/^\d+[.)]\s*/, '')
		.trim();
	if (!candidate || /(?:\.\.\.|…)(?:\s*\[\d+\])?$/.test(candidate)) return '';
	const sentences = candidate.split(/(?<=[.!?])\s+/);
	const complete = sentences.find(
		(sentence) =>
			sentence.length >= 20 &&
			/[.!?](?:["')\]]+)?$/.test(sentence) &&
			!looksLikeHeadlineBlob(sentence)
	);
	if (complete) return complete.replace(/\s*\[\d+\]\s*$/, '').trim();
	if (candidate.length < 20 || looksLikeHeadlineBlob(candidate)) return '';
	return ensureTerminalPunctuation(candidate.replace(/\s*\[\d+\]\s*$/, '').trim());
}

function withImplicitCitationNumbers(evidence: EvidenceObject[]): EvidenceObject[] {
	const used = new Set(
		evidence
			.map((item) => item.citation_number)
			.filter((number): number is number => Number.isInteger(number) && Number(number) > 0)
	);
	let next = 1;
	return evidence.map((item) => {
		if (item.citation_number != null) return item;
		while (used.has(next)) next += 1;
		const citationNumber = next;
		used.add(citationNumber);
		next += 1;
		return { ...item, citation_number: citationNumber };
	});
}

function documentChatAnswer(evidence: EvidenceObject[], prompt: string): string {
	const requestedCount = requestedListCount(prompt);
	const limit = requestedCount >= 9 ? Math.min(12, requestedCount) : 6;
	const statements = evidence.slice(0, limit).map((item, index) => {
		const citationNumber = item.citation_number ?? index + 1;
		return `${summaryFor(item, 420)} [${citationNumber}]`;
	});
	if (statements.length === 1) return statements[0];
	return ['**Document summary**', '', ...statements.map((statement) => `- ${statement}`)].join('\n');
}

function requestedListCount(prompt: string): number {
	const words: Record<string, number> = { nine: 9, ten: 10, eleven: 11, twelve: 12 };
	const match = prompt.match(/\b(nine|ten|eleven|twelve|1[0-2])\b/i);
	if (!match) return 0;
	return words[match[1].toLowerCase()] || Number(match[1]) || 0;
}

function formatChatToolAnswer(prompt: string, answer: string): string {
	return cleanVisibleChatOutput(answer, prompt);
}

function chatToolAnswerCaveats(prompt: string, caveats: string[]): string[] {
	if (needsExplicitVerificationCaveat(prompt)) {
		return caveats.map((item) =>
			/^I couldn't verify this from readable sources right now\.$/i.test(item)
				? 'This lead is not backed by readable source evidence yet.'
				: item
		);
	}
	return caveats.filter(
		(item) =>
			!/^I could not find reliable sources confirming this\b/i.test(item) &&
			!/^I couldn't verify this from readable sources\b/i.test(item)
	);
}

export function cleanVisibleChatOutput(answer: string, prompt = ''): string {
	const cleaned = softenUnsupportedScheduleAbsence(
		cleanChatToolAnswer(answer, { preserveUrls: wantsDirectUrls(prompt) }),
		prompt
	);
	if (wantsTable(prompt)) return compactChatText(cleaned, 8000);
	return polishedChatText(cleaned, 8000);
}

function softenUnsupportedScheduleAbsence(value: string, prompt: string): string {
	if (!/\b(?:schedule|scheduled|fixture|fixtures|games?|matches?)\b/i.test(prompt)) return value;
	return value
		.replace(
			/\bThere are no ([^.]*?\b(?:games?|matches?|fixtures?)\b[^.]*?) scheduled\b/gi,
			'I found no $1 listed as scheduled'
		)
		.replace(/\b(?:show|shows|showed) no fixtures\b/gi, 'did not show any fixtures');
}

export function draftNewsroomOcvoFromConversation(
	prompt: string,
	context: ConversationContext | undefined
): string | null {
	if (context?.intent !== 'transform' || !context.lastSourceBackedAnswer || !wantsNewsroomOcvo(prompt)) {
		return null;
	}
	const resolvableCitationNumbers = new Set(
		context.lastSourceBackedAnswer.citations.map((citation) => citation.citationNumber)
	);
	const sourceAnswer = stripUnresolvedCitationMarkers(
		sanitizeOcvoSourceText(context.lastSourceBackedAnswer.content),
		resolvableCitationNumbers
	);
	if (!sourceAnswer) return null;
	const sentences = splitScriptSentences(sourceAnswer);
	const scriptSentences = selectCitationPreservingScriptSentences(
		sentences.length ? sentences : [sourceAnswer],
		resolvableCitationNumbers
	);
	const scriptLines = dedupeVisibleCitationMarkers(scriptSentences, resolvableCitationNumbers)
		.map((sentence, index) => scriptLine(sentence, index === 0 ? 260 : 280, resolvableCitationNumbers))
		.filter(Boolean);
	const fallbackVo = nonClaimVoFallback();
	const fallbackWords = wordCount(fallbackVo);
	const scriptBudget = requestedOcvoWordBudget(prompt);
	const reserveFallback = scriptLines.length <= 1 ? fallbackWords : 0;
	const boundedScriptLines = limitScriptLinesToWordBudget(
		scriptLines.length ? scriptLines : [scriptLine(sourceAnswer, 260, resolvableCitationNumbers)],
		Math.max(1, scriptBudget - reserveFallback)
	);
	const onCam = boundedScriptLines[0] || scriptLine(sourceAnswer, 260, resolvableCitationNumbers);
	const vo = uniqueScriptLines(boundedScriptLines.slice(1), onCam);
	if (!vo.length) vo.push(fallbackVo);
	const tease = wantsTease(prompt) ? teaseTextForContext(context) : '';
	const banner = excludesBanner(prompt) ? '' : bannerTextForContext(context, sourceAnswer);
	return [
		...(tease ? ['TEASE:', tease, ''] : []),
		'ON CAM:',
		onCam,
		'',
		'VO:',
		...vo,
		...(banner ? ['', 'BANNER:', banner] : [])
	].join('\n');
}

function wantsNewsroomOcvo(prompt: string): boolean {
	return /\b(?:ocvo|oc\/vo|on[- ]?cam(?:era)?|voice[- ]?over|vo|script)\b/i.test(prompt);
}

function wantsTease(prompt: string): boolean {
	return /\btease\b/i.test(prompt);
}

function excludesBanner(prompt: string): boolean {
	return /\b(?:no|without)\s+(?:a\s+)?banner\b/i.test(prompt) ||
		/\bdo not (?:add|include|write)\s+(?:a\s+)?banner\b/i.test(prompt);
}

function teaseTextForContext(context: ConversationContext): string {
	const topic = context.activeTopic;
	const subject = compactText(topic?.subject || 'this developing story', 96)
		.replace(/\[\d+\]/g, '')
		.replace(/[.!?]$/, '');
	return ensureTerminalPunctuation(`What the latest confirmed evidence says about ${subject}`);
}

function sanitizeOcvoSourceText(value: string): string {
	const withoutSections = cleanChatToolAnswer(value)
		.replace(/\[(?:Sources?|End|END|source list|source)\]/gi, ' ')
		.replace(/(?:^|\n)\s*(?:ON\s*CAM|ONCAM|VO|V\/O|BANNER|SUPER)\s*:?\s*/gi, '\n')
		.replace(/\b(?:ON\s*CAM|ONCAM)\s*:\s*(?=\S)/gi, '\n')
		.replace(/\b(?:V\/O|VO)\s*:\s*(?=\S)/gi, '\n')
		.replace(/\bBANNER\s*:\s*(?=\S)/gi, '\n')
		.replace(
			/(?:^|\n)\s*.*\b(?:openai|perplexity|web_search|tool call|provider|http\s*\d{3}|status code|api key|model)\b.*$/gim,
			'\n'
		)
		.replace(/(?:^|\n)\s*(?:version|take)\s+\d+\s*:?\s*/gi, '\n')
		.replace(/\b(?:If you(?:'|’)d like|Would you like|Do you want)\b[\s\S]*$/i, '')
		.replace(/\s+/g, ' ')
		.trim();
	return withoutSections.replace(/\s+([,.;:!?])/g, '$1');
}

function splitScriptSentences(value: string): string[] {
	const protectedText = value
		.replace(/\[(\d+)\]/g, '{{$1}}')
		.replace(/\b([ap])\.m\./gi, (_, period: string) => `{{${period.toLowerCase()}m}}`);
	return protectedText
		.split(/(?<=[.!?])\s+/)
		.map((sentence) =>
			sentence
				.replace(/\{\{(\d+)\}\}/g, '[$1]')
				.replace(/\{\{([ap])m\}\}/g, '$1.m.')
				.trim()
		)
		.filter((sentence) => sentence.length >= 8);
}

export function directCitationLinksFromConversation(
	prompt: string,
	context: ConversationContext | undefined
): string | null {
	if (!context?.lastSourceBackedAnswer || !wantsDirectUrls(prompt)) return null;
	const citations = context.lastSourceBackedAnswer.citations;
	if (!citations.length) return 'No resolved citation links are available in the selected answer.';
	return citations.map((citation) => `${citation.citationNumber}. ${citation.url}`).join('\n');
}

function selectCitationPreservingScriptSentences(sentences: string[], citationNumbers: Set<number>): string[] {
	const targetNumbers = new Set(
		sentences.flatMap((sentence) => citationMarkersInText(sentence).filter((number) => citationNumbers.has(number)))
	);
	if (!targetNumbers.size) return uniqueScriptLines(sentences, '').slice(0, 4);

	const selected: string[] = [];
	const covered = new Set<number>();
	for (const sentence of sentences) {
		const markers = citationMarkersInText(sentence).filter((number) => targetNumbers.has(number));
		if (!markers.some((number) => !covered.has(number))) continue;
		selected.push(sentence);
		for (const marker of markers) covered.add(marker);
		if (covered.size === targetNumbers.size) break;
	}
	return selected.length ? selected : uniqueScriptLines(sentences, '').slice(0, 4);
}

function dedupeVisibleCitationMarkers(sentences: string[], citationNumbers: Set<number>): string[] {
	const seen = new Set<number>();
	return sentences
		.map((sentence) =>
			sentence
				.replace(/\[(\d+)\]/g, (marker, rawNumber: string) => {
					const number = Number(rawNumber);
					if (!citationNumbers.has(number) || seen.has(number)) return '';
					seen.add(number);
					return marker;
				})
				.replace(/\s+([,.;:!?])/g, '$1')
				.replace(/\s{2,}/g, ' ')
				.trim()
		)
		.filter(Boolean);
}

function stripUnresolvedCitationMarkers(value: string, citationNumbers: Set<number>): string {
	return value
		.replace(/\[(\d+)\]/g, (marker, rawNumber: string) =>
			citationNumbers.has(Number(rawNumber)) ? marker : ''
		)
		.replace(/\s+([,.;:!?])/g, '$1')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

function nonClaimVoFallback(): string {
	return 'No additional sourced VO detail is confirmed in the selected answer.';
}

function requestedOcvoWordBudget(prompt: string): number {
	const match = prompt.match(
		/\b(\d{1,3})\s*(?:-|\s)?\s*seconds?\s+(?:oc\s*\/?\s*vo|voice[- ]?over|script)\b/i
	);
	const seconds = match ? Number(match[1]) : 30;
	return Math.max(20, Math.min(180, Math.floor(seconds * 2.5)));
}

function limitScriptLinesToWordBudget(lines: string[], budget: number): string[] {
	const selected: string[] = [];
	let used = 0;
	for (const line of lines) {
		const words = wordCount(line);
		if (selected.length && used + words > budget) continue;
		const fitted = words > budget - used ? fitScriptLineToWordBudget(line, budget - used) : line;
		if (!fitted) continue;
		selected.push(fitted);
		used += wordCount(fitted);
		if (used >= budget) break;
	}
	return selected;
}

function fitScriptLineToWordBudget(line: string, budget: number): string {
	if (budget <= 0) return '';
	const markers = Array.from(line.matchAll(/\[(\d+)\]/g), (match) => match[0]);
	const prose = line.replace(/\s*\[\d+\]/g, '').trim();
	const words = prose.split(/\s+/).filter(Boolean);
	const proseBudget = Math.max(1, budget - markers.length);
	const shortened = words.length > proseBudget ? `${words.slice(0, proseBudget).join(' ')}…` : prose;
	return ensureTerminalPunctuation(`${shortened}${markers.length ? ` ${markers.join(' ')}` : ''}`);
}

function wordCount(value: string): number {
	return value.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’.-]*\b/gu)?.length ?? 0;
}

function citationMarkersInText(value: string): number[] {
	return Array.from(value.matchAll(/\[(\d+)\]/g), (match) => Number(match[1])).filter((number) =>
		Number.isInteger(number)
	);
}

function uniqueScriptLines(sentences: string[], existing: string): string[] {
	const seen = new Set([normalizeComparable(existing)]);
	const result: string[] = [];
	for (const sentence of sentences) {
		const key = normalizeComparable(sentence);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(sentence);
	}
	return result;
}

function scriptLine(value: string, maxLength: number, citationNumbers?: Set<number>): string {
	const uncitedFallback = () => ensureTerminalPunctuation(compactText(value, maxLength).replace(/^[-*]\s*/, '').trim());
	const cleaned = compactText(value, Number.MAX_SAFE_INTEGER).replace(/^[-*]\s*/, '').trim();
	const markers = citationNumbers ? uniqueResolvableCitationMarkers(cleaned, citationNumbers) : [];
	if (!markers.length) return uncitedFallback();
	return ensureTerminalPunctuation(shortenCitationBearingScriptLine(cleaned, maxLength, markers));
}

function shortenCitationBearingScriptLine(value: string, maxLength: number, markers: number[]): string {
	const cleaned = collapseScriptWhitespace(value);
	const markerLabels = markers.map((number) => `[${number}]`);
	const markerSuffix = ` ${markerLabels.join(' ')}`;
	if (cleaned.length <= maxLength && markerLabels.every((marker) => cleaned.includes(marker))) {
		return cleaned;
	}
	const suffix = `${markerSuffix}.`;
	const proseBudget = Math.max(0, maxLength - suffix.length);
	const markerlessProse = collapseScriptWhitespace(cleaned.replace(/\s*\[\d+\]/g, ''));
	const shortenedProse = compactCitationProse(markerlessProse, proseBudget).replace(/[.!?]$/, '');
	return `${shortenedProse}${suffix}`.trim();
}

function uniqueResolvableCitationMarkers(value: string, citationNumbers: Set<number>): number[] {
	const seen = new Set<number>();
	const markers: number[] = [];
	for (const number of citationMarkersInText(value)) {
		if (!citationNumbers.has(number) || seen.has(number)) continue;
		seen.add(number);
		markers.push(number);
	}
	return markers;
}

function compactCitationProse(value: string, maxLength: number): string {
	const cleaned = collapseScriptWhitespace(value);
	if (maxLength <= 0) return '';
	if (cleaned.length <= maxLength) return cleaned;
	if (maxLength === 1) return '…';
	return `${cleaned.slice(0, maxLength - 1).trim()}…`;
}

function collapseScriptWhitespace(value: string): string {
	return value
		.replace(/\s+([,.;:!?])/g, '$1')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

function ensureTerminalPunctuation(value: string): string {
	if (!value) return value;
	return /[.!?]\s*(?:\[\d+\])?$/.test(value) ? value : `${value}.`;
}

function bannerTextForContext(context: ConversationContext, sourceAnswer: string): string {
	const candidates = [
		context.activeTopic?.location && context.activeTopic.subject
			? `${context.activeTopic.location}: ${context.activeTopic.subject}`
			: '',
		context.activeTopic?.subject || '',
		sourceAnswer
	];
	const candidate = candidates.find((item) => item.trim()) || '';
	return compactText(candidate.replace(/\[\d+\]/g, ''), 64).replace(/[.!?]$/, '');
}

function wantsTable(prompt: string): boolean {
	return /\b(table|tabular|rows?|columns?)\b/i.test(prompt);
}

function wantsDirectUrls(prompt: string): boolean {
	return /\b(?:exact|direct|raw)\s+(?:links?|urls?)\b/i.test(prompt) ||
		/\b(?:give|show|list|include)\b[\s\S]{0,40}\b(?:links?|urls?)\b/i.test(prompt);
}

function chatNoLead(unusableEvidence: EvidenceObject[], limitations: string[] = []): string {
	const notes = sourceIssueNotes(unusableEvidence).slice(0, 3);
	const caveats = publicCaveatsFor('', [], unusableEvidence, limitations, { noUsableEvidence: true });
	return [
		...(caveats.length ? caveats : ["I couldn't verify this from readable sources right now."]),
		...notes
	]
		.filter(Boolean)
		.join('\n');
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

function directAnswerFallback(prompt: string): string {
	const normalized = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
	if (/\b(headline|hed)\b/.test(normalized)) {
		return [
			'Here are a few newsroom-safe headline directions:',
			'- Lead with the clearest confirmed action or decision.',
			'- Keep attribution visible if the claim is not independently verified.',
			'- Avoid implying certainty beyond the material provided.'
		].join('\n');
	}
	if (/\b(plan|outline|brainstorm|pitch)\b/.test(normalized)) {
		return [
			'Here is a compact way to structure it:',
			'1. Define the audience and the decision they need to make.',
			'2. Separate confirmed facts, open questions, and assumptions.',
			'3. Pick the strongest angle, then list the reporting or production steps needed to support it.'
		].join('\n');
	}
	if (/\b(rewrite|edit|polish|tighten|make this clearer)\b/.test(normalized)) {
		return 'I can help rewrite it. Send the text and the target tone, length, and audience.';
	}
	return [
		'I can help with that directly.',
		'For anything factual, current, or source-backed, ask me to check sources and I will route it through research.'
	].join('\n\n');
}

interface BriefItem {
	evidence: EvidenceObject;
	title: string;
	source: string;
	detail: string;
}

function leadParagraph(prompt: string, evidence: EvidenceObject[], briefItems: BriefItem[]): string {
	const official = evidence.filter((item) => item.source_kind === 'official' || item.source_kind === 'primary');
	const media = evidence.filter(
		(item) => item.source_kind === 'media_report' || item.source_kind === 'news_report'
	);
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
	const mediaCount = evidence.filter(
		(item) => item.source_kind === 'media_report' || item.source_kind === 'news_report'
	).length;
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
	const priority: Record<EvidenceSourceKind, number> = {
		official: 0,
		primary: 1,
		user_document: 2,
		internal: 3,
		news_report: 4,
		media_report: 4,
		commercial: 5,
		social_post: 6,
		unknown: 7
	};
	return priority[item.source_kind || 'unknown'];
}

function evidenceTimeMs(item: EvidenceObject): number {
	const parsed = Date.parse(item.published_at || '');
	return Number.isFinite(parsed) ? parsed : 0;
}

function kindLabel(item: EvidenceObject): string {
	if (item.source_kind === 'official') return 'official source';
	if (item.source_kind === 'primary') return 'primary source';
	if (item.source_kind === 'media_report' || item.source_kind === 'news_report') return 'news report';
	if (item.source_kind === 'user_document') return 'user document';
	if (item.source_kind === 'social_post') return 'social post';
	if (item.source_kind === 'commercial') return 'commercial source';
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

function cleanChatToolAnswer(value: string, options: { preserveUrls?: boolean } = {}): string {
	return normalizeChatAnswerWhitespace(repairInlineStoryLines(stripCitationChatter(stripSourceSections(value), options)));
}

function stripSourceSections(value: string): string {
	return value
		.replace(
			/(?:^|\n)\s*(?:#{1,6}\s*)?(?:sources?|references?|citations?)\b\s*:?\s*[\s\S]*$/i,
			''
		)
		.replace(/(?:^|\n)\s*(?:[-*]\s*)?\[[^\]]+\]\(https?:\/\/[^)]+\)[^\n]*/gi, '');
}

function stripCitationChatter(value: string, options: { preserveUrls?: boolean } = {}): string {
	const cleaned = value
		.replace(
			/(?:^|\n)\s*If you(?:'|’)d like,\s*(?:the )?next step can be[\s\S]*?(?=\n{2,}|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*(?:Would you like|Do you want) (?:me )?to[\s\S]*?(?=\n{2,}|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*If you want,?\s+(?:I|we|NewsCraft)\s+(?:can|could|will)\b[\s\S]*$/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*If you want one clear next step\b[\s\S]*?(?=\n{2,}\*\*Attached document evidence\*\*|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*If you prefer immediate verification\b[\s\S]*?(?=\n{2,}\*\*Attached document evidence\*\*|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*(?:[-*]\s*)?If you meant\b[^\n]*(?:\bsay which\b|\btell me\b|\bI(?:'|’)ll\b|\bI will\b)[^\n]*(?=\n|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*(?:#{1,6}\s*)?What I can do next\b[\s\S]*?(?=\n{2,}(?:Quick factual anchor|Attached document evidence)\b|$)/gi,
			''
		)
		.replace(/(?:^|\n)\s*(?:Which|What) next step do you want\??\s*$/gi, '')
		.replace(
			/(?:^|\n)\s*(?:[-*]\s*)?If you need\b[^\n]*(?:\bI|we|NewsCraft)\s+(?:can|could|will)\b[^\n]*(?=\n|$)/gi,
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
		.replace(/\bIt is based on media\/search results and should be checked against a primary source before publication\.?/gi, '');
	if (options.preserveUrls) return cleaned;
	return cleaned
		.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, '$1')
		.replace(/https?:\/\/\S+/gi, '')
		.replace(/\s+\((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^)]*)?\)/gi, '');
}

function normalizeChatAnswerWhitespace(value: string): string {
	return value
		.replace(/\.:\s+(?=[A-Z])/g, '.\n- ')
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
	const bounded = cleaned.length <= maxLength ? cleaned : truncateTextAtBoundary(cleaned, maxLength);
	return trimIncompleteTrailingParagraph(bounded);
}

function truncateTextAtBoundary(value: string, maxLength: number): string {
	const slice = value.slice(0, maxLength);
	const paragraph = slice.lastIndexOf('\n\n');
	const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
	const boundary = Math.max(paragraph, sentence >= 0 ? sentence + 1 : -1);
	return slice.slice(0, boundary > maxLength * 0.55 ? boundary : maxLength).trim();
}

function trimIncompleteTrailingParagraph(value: string): string {
	if (/[.!?]["')\]]*(?:\s*\[\d+\])?$/.test(value) || /\[\d+\]$/.test(value)) return value;
	const paragraph = value.lastIndexOf('\n\n');
	if (paragraph > 0) return value.slice(0, paragraph).trim();
	const sentence = Math.max(value.lastIndexOf('. '), value.lastIndexOf('! '), value.lastIndexOf('? '));
	return sentence > value.length * 0.55 ? value.slice(0, sentence + 1).trim() : value;
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
	const missingOutletCoverage = combinedLimitations
		.map(missingOutletCoverageLimitation)
		.find((item): item is string => Boolean(item));
	const blocked = combinedLimitations.some((item) => /paywall|subscription|login|captcha|blocked|unavailable|access denied|access was restricted|requires access|forbidden|could not be read/i.test(item));
	if (options.noUsableEvidence) {
		if (providerConfigurationLimitation) caveats.push(providerConfigurationLimitation);
		else {
			caveats.push(
				blocked
					? "I couldn't verify this because the available sources were blocked, paywalled, unavailable, or unreadable."
					: "I couldn't verify this from readable sources right now."
			);
		}
		if (missingOutletCoverage) caveats.push(missingOutletCoverage);
		return caveats;
	}
	if (providerConfigurationLimitation) caveats.push(providerConfigurationLimitation);
	if (missingOutletCoverage) caveats.push(missingOutletCoverage);

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
	return /\b(verify|verification|confirm|official|primary|source of truth|what .* officially said|government|parliament|minister|ministry|department|agency|police|sheriff|court|legal|lawsuit|charges?|arrest|elections?|ballot|vote count|schedule|fixtures?|kick[- ]?off|tip[- ]?off)\b/i.test(
		prompt
	);
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
	const missingOutletCoverage = missingOutletCoverageLimitation(value);
	if (missingOutletCoverage) return missingOutletCoverage;
	if (/paywall|subscription|login|captcha|blocked|access denied|forbidden|could not be read|unavailable/i.test(value)) {
		return 'A candidate source was blocked, paywalled, unavailable, or could not be read. It was not used as evidence.';
	}
	if (/no usable|no cited sources|no readable|no .*source/i.test(value)) {
		return 'No usable source material was available from one attempted source.';
	}
	return '';
}

function missingOutletCoverageLimitation(value: string): string | null {
	const match = value.match(/^No readable article-level evidence was found from (.+)\.$/i);
	if (!match) return null;
	return `I did not find readable article-level coverage from ${match[1]} in this research pass.`;
}

function providerUnavailableLimitation(value: string): string | null {
	const match = value.match(
		/^\s*(openai|perplexity)\s+web_search is not configured because\s+([A-Z_]+)\s+is missing\.?$/i
	);
	if (!match) return null;
	const apiKeyName = match[2].toUpperCase();
	if (!/OPENAI_API_KEY|PERPLEXITY_API_KEY/.test(apiKeyName)) return null;
	return 'Live research is temporarily unavailable.';
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
