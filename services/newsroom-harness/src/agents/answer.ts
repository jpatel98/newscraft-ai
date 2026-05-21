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
}

export function generateFinalAnswer(input: AnswerGenerationInput): string {
	const sortedEvidence = [...input.evidence].sort(compareEvidencePriority);
	const evidence = sortedEvidence.filter(isUsableEvidence);
	const unusableEvidence = sortedEvidence.filter((item) => !isUsableEvidence(item));
	if (input.decision.selected_mode === 'clarification_needed') {
		return 'I need a specific source, story, document, or mission output to check before I can answer cleanly.';
	}
	if (input.decision.selected_mode === 'answer_from_memory') {
		return answerFromMemory(input.prompt);
	}
	if (!evidence.length && input.toolAnswers?.length) {
		return input.toolAnswers.join('\n\n').trim();
	}
	if (!evidence.length) {
		return noPublishableLeadReport(unusableEvidence);
	}

	const lead = leadParagraph(input.prompt, evidence);
	const leadCandidates = evidence.slice(0, 5).map((item) => `- ${sourceLabel(item)}: ${summaryFor(item)}`);
	const listedSources = evidence.slice(0, 12);
	const sourceNotes = [
		...listedSources.map((item) => {
			const timestamp = [item.published_at ? `published ${item.published_at}` : null, `accessed ${item.accessed_at}`]
				.filter(Boolean)
				.join('; ');
			return `- ${formatSourceLink(item)} - ${kindLabel(item)}; ${timestamp}. ${summaryFor(item)}`;
		}),
		...(evidence.length > listedSources.length
			? [`- ${evidence.length - listedSources.length} additional usable sources were recorded and omitted from this compact brief.`]
			: []),
		...sourceIssueNotes(unusableEvidence)
	];
	const verificationNotes = verificationNotesFor(input.prompt, evidence, unusableEvidence);

	return [
		'## Summary',
		lead,
		'',
		'## Lead Candidates',
		leadCandidates.join('\n'),
		'',
		'## Source Notes',
		sourceNotes.join('\n'),
		'',
		'## Verification Notes',
		verificationNotes.join('\n'),
		'',
		'## Human Review',
		'A producer or editor should confirm story angle, public-interest value, legal/privacy sensitivity, and any publishable wording before use.'
	].join('\n');
}

function answerFromMemory(prompt: string): string {
	const normalized = prompt.toLowerCase();
	if (/\bnut graf\b/.test(normalized)) {
		return 'A nut graf is the early paragraph that tells the audience what the story is really about and why it matters. It should clarify the stakes, context, and reason to keep reading without overstating facts.';
	}
	if (/\bproducer brief|newsroom brief\b/.test(normalized)) {
		return 'A producer-ready brief should state what happened, what is new, why it matters, what is confirmed, what still needs checking, and which sources support each point.';
	}
	return 'This appears to be stable newsroom guidance rather than a live-source request. I would answer from established practice, and I would not claim to have checked current sources unless a tool run is routed.';
}

function leadParagraph(prompt: string, evidence: EvidenceObject[]): string {
	const official = evidence.filter((item) => item.source_kind === 'official' || item.source_kind === 'primary');
	const media = evidence.filter((item) => item.source_kind === 'media_report');
	const newest = evidence[0];
	const base = summaryFor(newest, 420);
	const sourceFraming =
		official.length && media.length
			? `The gathered evidence includes ${official.length} official or primary source${official.length === 1 ? '' : 's'} and ${media.length} media report${media.length === 1 ? '' : 's'}.`
			: official.length
				? `The gathered evidence is led by official or primary source material.`
				: media.length
					? `The gathered evidence is based on media reports and still needs primary-source confirmation.`
					: `The gathered evidence should be treated as preliminary.`;
	const changed = /\b(latest|new|changed|update|today|recent)\b/i.test(prompt)
		? ` Latest candidate sources are listed below.`
		: '';
	return `${base}\n\n${sourceFraming}${changed}`;
}

function verificationNotesFor(prompt: string, evidence: EvidenceObject[], unusableEvidence: EvidenceObject[]): string[] {
	const notes: string[] = [];
	const officialCount = evidence.filter((item) => item.source_kind === 'official' || item.source_kind === 'primary').length;
	const mediaCount = evidence.filter((item) => item.source_kind === 'media_report').length;
	if (officialCount) notes.push(`- Official or primary source material is available for editor review: ${officialCount}.`);
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
	return notes.length ? notes : ['- No additional verification notes were generated.'];
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

function compareEvidencePriority(left: EvidenceObject, right: EvidenceObject): number {
	const priority = { official: 0, primary: 1, internal: 2, media_report: 3, unknown: 4 };
	const leftPriority = priority[left.source_kind || 'unknown'];
	const rightPriority = priority[right.source_kind || 'unknown'];
	if (leftPriority !== rightPriority) return leftPriority - rightPriority;
	return Date.parse(right.published_at || right.accessed_at) - Date.parse(left.published_at || left.accessed_at);
}

function sourceLabel(item: EvidenceObject): string {
	return `${compactText(item.title, 90)} (${kindLabel(item)})`;
}

function kindLabel(item: EvidenceObject): string {
	if (item.source_kind === 'official') return 'official source';
	if (item.source_kind === 'primary') return 'primary source';
	if (item.source_kind === 'media_report') return 'media report';
	if (item.source_kind === 'internal') return 'internal NewsCraft source';
	return 'source';
}

function formatSourceLink(item: EvidenceObject): string {
	const label = compactText(item.title, 90).replace(/\]/g, ')');
	if (item.source_url.startsWith('newsroom://') || item.source_url === 'about:blank') {
		return `${label} (${item.source_url})`;
	}
	return `[${label}](${item.source_url})`;
}

function summaryFor(item: EvidenceObject, maxLength = 260): string {
	return compactText(item.summary || item.extracted_text || item.title, maxLength);
}

function compactText(value: string, maxLength: number): string {
	const cleaned = value
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/[*_~>`#-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function noPublishableLeadReport(unusableEvidence: EvidenceObject[]): string {
	const sourceNotes = sourceIssueNotes(unusableEvidence);
	return [
		'## Summary',
		'No publishable lead was found in this run because no usable source material was available.',
		'',
		'## Lead Candidates',
		'- No lead candidates. Do not assign or publish from this run without a readable source.',
		'',
		'## Source Notes',
		sourceNotes.length ? sourceNotes.join('\n') : '- No readable source material was available from this run.',
		'',
		'## Verification Notes',
		'- Re-run after the source is readable, attach a source feed, or verify the story against a readable primary or reliable secondary source.',
		'',
		'## Human Review',
		'A producer or editor should review the source setup before using this mission for coverage decisions.'
	].join('\n');
}

function sourceIssueNotes(evidence: EvidenceObject[]): string[] {
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
	return notes;
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
