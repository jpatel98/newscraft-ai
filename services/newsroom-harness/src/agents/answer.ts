import type { ToolBudgetSnapshot } from './budget.js';
import type { EvidenceObject } from './evidence.js';
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
	const evidence = [...input.evidence].sort(compareEvidencePriority);
	if (input.decision.selected_mode === 'clarification_needed') {
		return 'I need a specific source, story, document, or mission output to check before I can answer cleanly.';
	}
	if (input.decision.selected_mode === 'answer_from_memory') {
		return answerFromMemory(input.prompt);
	}
	if (!evidence.length && input.toolAnswers?.length) {
		return withLimitations(input.toolAnswers.join('\n\n'), input.limitations, input.budget);
	}
	if (!evidence.length) {
		return withLimitations(
			[
				'I do not have enough sourced evidence to answer the request.',
				'No facts have been inferred beyond the available tool results.'
			].join('\n\n'),
			input.limitations.length ? input.limitations : ['No evidence objects were produced by the selected tools.'],
			input.budget
		);
	}

	const lead = leadParagraph(input.prompt, evidence);
	const leadCandidates = evidence.slice(0, 5).map((item) => `- ${sourceLabel(item)}: ${item.summary || item.title}`);
	const sourceNotes = evidence.map((item) => {
		const timestamp = [item.published_at ? `published ${item.published_at}` : null, `accessed ${item.accessed_at}`]
			.filter(Boolean)
			.join('; ');
		return `- ${formatSourceLink(item)} - ${kindLabel(item)}; ${timestamp}. ${item.summary || item.title}`;
	});
	const verificationNotes = verificationNotesFor(input.prompt, evidence, input.limitations);

	return withLimitations(
		[
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
		].join('\n'),
		input.limitations,
		input.budget
	);
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
	const base = `${newest.summary || newest.title}`;
	const sourceFraming =
		official.length && media.length
			? `The gathered evidence includes ${official.length} official or primary source${official.length === 1 ? '' : 's'} and ${media.length} media report${media.length === 1 ? '' : 's'}.`
			: official.length
				? `The gathered evidence is led by official or primary source material.`
				: media.length
					? `The gathered evidence is based on media reports and still needs primary-source confirmation.`
					: `The gathered evidence should be treated as preliminary.`;
	const changed = /\b(latest|new|changed|update|today|recent)\b/i.test(prompt)
		? ` What is new: ${evidence
				.slice(0, 3)
				.map((item) => item.title)
				.join('; ')}.`
		: '';
	return `${base}\n\n${sourceFraming}${changed}`;
}

function verificationNotesFor(prompt: string, evidence: EvidenceObject[], limitations: string[]): string[] {
	const notes: string[] = [];
	const officialCount = evidence.filter((item) => item.source_kind === 'official' || item.source_kind === 'primary').length;
	const mediaCount = evidence.filter((item) => item.source_kind === 'media_report').length;
	if (officialCount) notes.push(`- Official/primary source evidence found: ${officialCount}.`);
	if (mediaCount) notes.push(`- Media-report evidence found: ${mediaCount}; attribute outlet reporting separately from official statements.`);
	if (detectPoliceLegalTask(prompt)) {
		notes.push(
			'- Police/legal caution: distinguish allegations, arrests, charges, and convictions. Do not imply guilt unless a conviction is documented.'
		);
	}
	const conflicts = detectConflicts(evidence);
	notes.push(
		conflicts.length
			? `- Potential conflicts to resolve: ${conflicts.join('; ')}.`
			: '- No conflicting claims were detected in the gathered evidence objects.'
	);
	for (const limitation of limitations) notes.push(`- Limitation: ${limitation}`);
	for (const item of evidence.flatMap((candidate) => candidate.limitations)) notes.push(`- Source limitation: ${item}`);
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

function withLimitations(answer: string, limitations: string[], budget: ToolBudgetSnapshot): string {
	const uniqueLimitations = [...new Set(limitations.filter(Boolean))];
	const budgetLine = `Tool budget used: ${budget.usage.total_tool_calls}/${budget.limits.max_total_tool_calls} calls.`;
	if (!uniqueLimitations.length) return `${answer}\n\n${budgetLine}`;
	return `${answer}\n\nLimitations:\n${uniqueLimitations.map((limitation) => `- ${limitation}`).join('\n')}\n\n${budgetLine}`;
}

function compareEvidencePriority(left: EvidenceObject, right: EvidenceObject): number {
	const priority = { official: 0, primary: 1, internal: 2, media_report: 3, unknown: 4 };
	const leftPriority = priority[left.source_kind || 'unknown'];
	const rightPriority = priority[right.source_kind || 'unknown'];
	if (leftPriority !== rightPriority) return leftPriority - rightPriority;
	return Date.parse(right.published_at || right.accessed_at) - Date.parse(left.published_at || left.accessed_at);
}

function sourceLabel(item: EvidenceObject): string {
	return `${item.title} (${kindLabel(item)})`;
}

function kindLabel(item: EvidenceObject): string {
	if (item.source_kind === 'official') return 'official source';
	if (item.source_kind === 'primary') return 'primary source';
	if (item.source_kind === 'media_report') return 'media report';
	if (item.source_kind === 'internal') return 'internal NewsCraft source';
	return 'source';
}

function formatSourceLink(item: EvidenceObject): string {
	const label = item.title.replace(/\]/g, ')');
	if (item.source_url.startsWith('newsroom://') || item.source_url === 'about:blank') {
		return `${label} (${item.source_url})`;
	}
	return `[${label}](${item.source_url})`;
}
