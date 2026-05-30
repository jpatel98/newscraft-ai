import type { NewsroomGateDto } from '@newscraft/shared';
import { DEFAULT_WORKSPACE_ID, type HarnessRepository } from '../db/repository.js';
import { nowIso } from '../util/ids.js';

type CopyStatus = 'completed' | 'blocked';
type CopyRisk = 'low' | 'medium' | 'high';
type FindingSeverity = 'low' | 'medium' | 'high';

export interface CopyInput {
	workspaceId?: string;
	storyId?: string | null;
	jobId?: string | null;
	runId?: string | null;
}

export interface CopyFinding {
	severity: FindingSeverity;
	code: string;
	text: string;
	match?: string;
	suggestion: string;
}

export interface CopyRunResult {
	ok: boolean;
	status: CopyStatus;
	events: Array<{ id: string; kind: string }>;
	risk: CopyRisk | null;
	findings: CopyFinding[];
	gate?: NewsroomGateDto;
	error?: string;
}

interface DraftForCopy {
	markdown: string;
	headline: string | null;
	event_id: string | null;
	created_at: string | null;
}

export function runCopyAgent(repository: HarnessRepository, input: CopyInput): CopyRunResult {
	const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
	const storyId = textOrNull(input.storyId);
	if (!storyId) {
		const event = repository.appendEvent({
			workspaceId,
			jobId: input.jobId,
			runId: input.runId,
			agent: 'copy',
			kind: 'copy.command.blocked',
			payload: {
				reason: 'Copy needs an active story workspace with a draft.'
			}
		});
		return {
			ok: false,
			status: 'blocked',
			events: [{ id: event.id, kind: event.kind }],
			risk: null,
			findings: [],
			error: 'Copy needs an active story workspace with a draft.'
		};
	}

	const draft = latestDraft(repository, storyId, workspaceId);
	if (!draft) {
		const event = repository.appendEvent({
			workspaceId,
			storyId,
			jobId: input.jobId,
			runId: input.runId,
			agent: 'copy',
			kind: 'copy.command.blocked',
			payload: {
				reason: 'Copy needs a draft before it can run a style and risk pass.'
			}
		});
		return {
			ok: false,
			status: 'blocked',
			events: [{ id: event.id, kind: event.kind }],
			risk: null,
			findings: [],
			error: 'Copy needs a draft before it can run a style and risk pass.'
		};
	}

	const houseMemory = repository.inspectHouseMemory();
	const styleGuide = stringValue(houseMemory.current.style_guide);
	const bannedPhrases = stringArray(houseMemory.current.banned_phrases);
	const libelPatterns = stringArray(houseMemory.current.libel_patterns);
	const findings = copyFindings(draft.markdown, { styleGuide, bannedPhrases, libelPatterns });
	const risk = riskFor(findings);
	const createdAt = nowIso();
	const event = repository.appendEvent({
		workspaceId,
		storyId,
		jobId: input.jobId,
		runId: input.runId,
		agent: 'copy',
		kind: 'copy.reviewed',
		payload: {
			story_id: storyId,
			headline: draft.headline,
			draft_event_id: draft.event_id,
			risk,
			findings,
			style_guide_applied: Boolean(styleGuide),
			style_guide_excerpt: styleGuide ? excerpt(styleGuide, 280) : null,
			advisory: true
		},
		parentEventId: draft.event_id,
		createdAt
	});

	const existingGate =
		risk === 'high'
			? repository.findOpenGate({
					workspaceId,
					storyId,
					type: 'legal_style',
					matches: (gate) => {
						const payload = objectValue(gate.payload) ?? {};
						return stringValue(payload.draft_event_id) === draft.event_id;
					}
				})
			: null;
	const gate =
		risk === 'high'
			? existingGate ??
				repository.queueGate({
					workspace_id: workspaceId,
					story_id: storyId,
					job_id: input.jobId,
					run_id: input.runId,
					type: 'legal_style',
					title: `Legal / Style review: ${draft.headline || 'Draft needs copy attention'}`,
					summary: 'Copy found high-risk legal or house-style issues. Editor approval is required before the draft advances.',
					priority: 1,
					created_by: 'copy',
					payload: {
						story_id: storyId,
						headline: draft.headline,
						draft_event_id: draft.event_id,
						copy_event_id: event.id,
						risk,
						findings,
						style_guide_applied: Boolean(styleGuide)
					}
				})
			: undefined;

	return {
		ok: true,
		status: 'completed',
		events: [{ id: event.id, kind: event.kind }],
		risk,
		findings,
		gate
	};
}

function latestDraft(repository: HarnessRepository, storyId: string, workspaceId: string): DraftForCopy | null {
	const memory = repository.inspectStoryMemory(storyId, workspaceId);
	const candidates = [
		...memory.entries
			.filter((entry) => entry.key === 'draft_history')
			.map((entry) => draftFromValue(entry.value, stringValue(objectValue(entry.value)?.event_id), entry.created_at)),
		...(memory.agent_event_log || [])
			.filter((event) => event.kind === 'draft.produced')
			.map((event) => draftFromValue(event.payload, event.id, event.created_at))
	].filter((draft): draft is DraftForCopy => Boolean(draft));
	const deduped = new Map<string, DraftForCopy>();
	for (const draft of candidates) {
		const key = draft.event_id || `${draft.created_at || ''}:${hashDraft(draft.markdown)}`;
		const existing = deduped.get(key);
		if (!existing || timestampMs(draft.created_at) >= timestampMs(existing.created_at)) deduped.set(key, draft);
	}
	return [...deduped.values()].sort((left, right) => timestampMs(left.created_at) - timestampMs(right.created_at)).at(-1) ?? null;
}

function draftFromValue(value: unknown, eventId: string | null, createdAt: string | null): DraftForCopy | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const markdown = stringValue(raw.draft_markdown) || stringValue(raw.draftMarkdown) || stringValue(raw.markdown);
	if (!markdown) return null;
	return {
		markdown,
		headline: stringValue(raw.headline),
		event_id: eventId,
		created_at: createdAt
	};
}

function copyFindings(
	markdown: string,
	memory: { styleGuide: string | null; bannedPhrases: string[]; libelPatterns: string[] }
): CopyFinding[] {
	const findings: CopyFinding[] = [];
	for (const phrase of memory.bannedPhrases) {
		if (containsPhrase(markdown, phrase)) {
			findings.push({
				severity: 'medium',
				code: 'banned_phrase',
				text: `House style discourages "${phrase}".`,
				match: phrase,
				suggestion: 'Rewrite with direct, specific language from the source record.'
			});
		}
	}
	for (const pattern of memory.libelPatterns) {
		if (containsPhrase(markdown, pattern)) {
			findings.push({
				severity: 'high',
				code: 'libel_pattern',
				text: `Potential libel/style risk matched "${pattern}".`,
				match: pattern,
				suggestion: 'Hold for editor/legal review unless the claim is attributed and source-backed.'
			});
		}
	}

	const legalRisk = unattributedLegalRisk(markdown);
	if (legalRisk) {
		findings.push({
			severity: 'high',
			code: 'unattributed_legal_risk',
			text: 'Legal-risk language appears without nearby attribution signals.',
			match: legalRisk.match,
			suggestion: 'Add precise attribution and avoid implying guilt or liability beyond the sourced record.'
		});
	}

	if (memory.styleGuide && /!\s/.test(markdown)) {
		findings.push({
			severity: 'low',
			code: 'tone',
			text: 'Draft uses emphatic punctuation that may conflict with restrained house style.',
			match: '!',
			suggestion: 'Use measured newsroom tone unless the style guide explicitly allows emphasis.'
		});
	}

	if (findings.length === 0) {
		findings.push({
			severity: 'low',
			code: 'clean_pass',
			text: 'No house-style, banned-phrase, or high-risk legal issues were detected.',
			suggestion: 'Keep copy output advisory until the editor approves the draft.'
		});
	}

	return findings;
}

function riskFor(findings: CopyFinding[]): CopyRisk {
	if (findings.some((finding) => finding.severity === 'high')) return 'high';
	if (findings.some((finding) => finding.severity === 'medium')) return 'medium';
	return 'low';
}

function containsPhrase(markdown: string, phrase: string): boolean {
	const trimmed = phrase.trim();
	if (!trimmed) return false;
	const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
	const startsWord = /^[A-Za-z0-9_]/.test(trimmed);
	const endsWord = /[A-Za-z0-9_]$/.test(trimmed);
	const source = `${startsWord ? '(^|[^A-Za-z0-9_])' : ''}${escaped}${endsWord ? '(?=$|[^A-Za-z0-9_])' : ''}`;
	return new RegExp(source, 'i').test(markdown);
}

function unattributedLegalRisk(markdown: string): { match: string } | null {
	const terms = new Set<string>();
	for (const segment of claimLikeSegments(markdown)) {
		const legalTerms = segment.match(/\b(accused|charged|arrested|convicted|fraud|criminal|lawsuit|defamation|denied)\b/gi) ?? [];
		if (legalTerms.length === 0) continue;
		if (/\b(according to|said|statement|court|police|documents?|records?)\b/i.test(segment)) continue;
		for (const term of legalTerms) terms.add(term.toLowerCase());
	}
	return terms.size ? { match: [...terms].join(', ') } : null;
}

function claimLikeSegments(markdown: string): string[] {
	return markdown
		.replace(/^#+\s+/gm, '')
		.split(/(?<=[.!?])\s+|\n{2,}/)
		.map((segment) => segment.replace(/\s+/g, ' ').trim())
		.filter(Boolean);
}

function timestampMs(value: string | null): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

function hashDraft(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
	}
	return String(hash);
}

function excerpt(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3).trim()}...`;
}

function textOrNull(value: string | null | undefined): string | null {
	const text = value?.trim();
	return text || null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.flatMap((candidate) => {
				const text = stringValue(candidate);
				return text ? [text] : [];
			})
		: [];
}
