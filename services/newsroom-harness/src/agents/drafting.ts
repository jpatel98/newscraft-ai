import type { NewsroomEventJson, NewsroomGateDto } from '@newscraft/shared';
import { DEFAULT_WORKSPACE_ID, type HarnessRepository, type ScopedMemoryInspectDto } from '../db/repository.js';
import { nowIso } from '../util/ids.js';

const DEFAULT_TARGET_WORDS = 300;
const MIN_TARGET_WORDS = 220;
const MAX_TARGET_WORDS = 360;

interface DraftingInput {
	storyId: string;
	workspaceId?: string;
	jobId?: string | null;
	runId?: string | null;
	targetWordCount?: number;
}

interface DraftFact {
	id: string;
	claim: string;
	sourceTitle: string;
	sourceUrl: string;
	sourceName: string;
	archiveSnapshotUrl: string;
	contentHash: string | null;
	eventId: string | null;
}

interface DraftCitation {
	marker: number;
	fact_id: string;
	claim: string;
	source_title: string;
	source_name: string;
	source_url: string;
	archive_snapshot_url: string;
	content_hash: string | null;
	event_id: string | null;
}

interface WebStoryDraft {
	format: 'web_story_300';
	markdown: string;
	headline: string;
	word_count: number;
	target_word_count: number;
	citations: DraftCitation[];
	facts_used: string[];
}

export interface DraftingRunResult {
	storyId: string;
	workspaceId: string;
	draft: WebStoryDraft;
	gate: NewsroomGateDto;
}

export class DraftingPreconditionError extends Error {}

export function runDraftingAgent(repository: HarnessRepository, input: DraftingInput): DraftingRunResult {
	const storyId = requiredText(input.storyId, 'story_id');
	const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
	const targetWordCount = clampTargetWordCount(input.targetWordCount);
	const memory = repository.inspectStoryMemory(storyId, workspaceId);
	const facts = verifiedSourceBackedFacts(memory);
	if (facts.length === 0) {
		throw new DraftingPreconditionError('Drafting requires at least one verified, source-backed fact ledger entry');
	}

	const draft = buildWebStoryDraft(storyId, facts, targetWordCount);
	const createdAt = nowIso();
	const event = repository.appendEvent({
		workspaceId,
		storyId,
		jobId: input.jobId,
		runId: input.runId,
		agent: 'drafting',
		kind: 'draft.produced',
		payload: {
			story_id: storyId,
			format: draft.format,
			headline: draft.headline,
			word_count: draft.word_count,
			target_word_count: draft.target_word_count,
			facts_used: draft.facts_used,
			citations: draft.citations,
			draft_markdown: draft.markdown
		},
		sources: draft.citations.map((citation) => ({
			url: citation.source_url,
			title: citation.source_title,
			fact_id: citation.fact_id,
			marker: citation.marker,
			archive_snapshot_url: citation.archive_snapshot_url,
			content_hash: citation.content_hash
		})),
		createdAt
	});
	const memoryEntry = repository.appendStoryMemory(storyId, {
		workspaceId,
		key: 'draft_history',
		kind: 'draft.produced',
		actor: 'drafting',
		createdAt,
		value: {
			format: draft.format,
			headline: draft.headline,
			word_count: draft.word_count,
			target_word_count: draft.target_word_count,
			facts_used: draft.facts_used,
			citations: draft.citations,
			draft_markdown: draft.markdown,
			event_id: event.id
		}
	});
	const gate = repository.queueGate({
		workspace_id: workspaceId,
		story_id: storyId,
		job_id: input.jobId,
		run_id: input.runId,
		type: 'draft_review',
		title: `Review draft: ${draft.headline}`,
		summary: `${draft.word_count}-word web story drafted only from verified fact-ledger entries.`,
		priority: 3,
		created_by: 'drafting',
		actions: ['approve', 'return_with_notes', 'spike'],
		payload: {
			story_id: storyId,
			format: draft.format,
			headline: draft.headline,
			word_count: draft.word_count,
			target_word_count: draft.target_word_count,
			facts_used: draft.facts_used,
			citations: draft.citations,
			draft_markdown: draft.markdown,
			draft_event_id: event.id,
			draft_memory_entry_id: memoryEntry.id
		}
	});

	return { storyId, workspaceId, draft, gate };
}

function verifiedSourceBackedFacts(memory: ScopedMemoryInspectDto): DraftFact[] {
	const facts: DraftFact[] = [];
	const seen = new Set<string>();
	for (const value of memory.current.fact_ledger || []) {
		const fact = factFromValue(value, null);
		if (!fact || seen.has(fact.id)) continue;
		seen.add(fact.id);
		facts.push(fact);
	}
	for (const event of memory.agent_event_log || []) {
		if (event.kind !== 'claim.verified') continue;
		const fact = factFromValue(event.payload, event.id, event.sources);
		if (!fact || seen.has(fact.id)) continue;
		seen.add(fact.id);
		facts.push(fact);
	}
	return facts;
}

function factFromValue(value: NewsroomEventJson, eventId: string | null, eventSources: NewsroomEventJson[] = []): DraftFact | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const claim = compactText(
		stringValue(raw.claim) ||
			stringValue(raw.text) ||
			stringValue(raw.sentence) ||
			stringValue(raw.detail) ||
			stringValue(raw.summary),
		360
	);
	if (!claim || !isVerifiedFact(raw, Boolean(eventId))) return null;
	const source = sourceFromValue(raw, eventSources);
	if (!source?.url) return null;
	const id =
		stringValue(raw.id) ||
		stringValue(raw.claim_id) ||
		stringValue(raw.fact_id) ||
		`${eventId || 'fact'}:${hashKey(`${claim}\n${source.url}`)}`;
	return {
		id,
		claim,
		sourceTitle: source.title || source.name || sourceHost(source.url),
		sourceName: source.name || source.title || sourceHost(source.url),
		sourceUrl: source.url,
		archiveSnapshotUrl: source.archiveSnapshotUrl || archiveFallbackUrl(source.url),
		contentHash: source.contentHash,
		eventId
	};
}

function isVerifiedFact(raw: Record<string, unknown>, verifiedByEvent: boolean): boolean {
	if (verifiedByEvent) return true;
	if (raw.verified === true) return true;
	const status = (
		stringValue(raw.status) ||
		stringValue(raw.verification_status) ||
		stringValue(raw.verificationStatus) ||
		stringValue(raw.state)
	).toLowerCase();
	return ['verified', 'source_backed', 'source-backed'].includes(status);
}

function sourceFromValue(
	raw: Record<string, unknown>,
	eventSources: NewsroomEventJson[] = []
): { title: string; name: string; url: string; archiveSnapshotUrl: string | null; contentHash: string | null } | null {
	const candidates = [
		...arrayValue(raw.sources),
		...arrayValue(raw.source_set),
		...arrayValue(raw.sourceSet),
		...eventSources
	];
	for (const candidate of candidates) {
		const source = sourceObject(candidate);
		if (source?.url) return source;
	}
	const url =
		stringValue(raw.source_url) ||
		stringValue(raw.sourceUrl) ||
		stringValue(raw.url) ||
		stringValue(objectValue(raw.provenance)?.url);
	if (!url) return null;
	const sourceUrl = safeHttpUrl(url);
	if (!sourceUrl) return null;
	return {
		url: sourceUrl,
		title: stringValue(raw.source_title) || stringValue(raw.sourceTitle) || stringValue(raw.title),
		name: stringValue(raw.source_name) || stringValue(raw.sourceName),
		archiveSnapshotUrl: safeHttpUrl(
			stringValue(raw.archive_snapshot_url) ||
				stringValue(raw.archiveSnapshotUrl) ||
				stringValue(raw.archive_url) ||
				stringValue(raw.archiveUrl) ||
				stringValue(raw.snapshot_url) ||
				stringValue(raw.snapshotUrl) ||
				stringValue(objectValue(raw.provenance)?.archive_snapshot_url) ||
				stringValue(objectValue(raw.provenance)?.archiveSnapshotUrl)
		),
		contentHash:
			stringValue(raw.content_hash) ||
			stringValue(raw.contentHash) ||
			stringValue(objectValue(raw.provenance)?.content_hash) ||
			stringValue(objectValue(raw.provenance)?.contentHash) ||
			null
	};
}

function sourceObject(value: unknown): { title: string; name: string; url: string; archiveSnapshotUrl: string | null; contentHash: string | null } | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const url = safeHttpUrl(stringValue(raw.url) || stringValue(raw.source_url) || stringValue(raw.sourceUrl));
	if (!url) return null;
	return {
		url,
		title: stringValue(raw.title) || stringValue(raw.source_title) || stringValue(raw.sourceTitle),
		name: stringValue(raw.name) || stringValue(raw.source_name) || stringValue(raw.sourceName),
		archiveSnapshotUrl: safeHttpUrl(
			stringValue(raw.archive_snapshot_url) ||
				stringValue(raw.archiveSnapshotUrl) ||
				stringValue(raw.archive_url) ||
				stringValue(raw.archiveUrl) ||
				stringValue(raw.snapshot_url) ||
				stringValue(raw.snapshotUrl)
		),
		contentHash: stringValue(raw.content_hash) || stringValue(raw.contentHash) || null
	};
}

function buildWebStoryDraft(storyId: string, facts: DraftFact[], targetWordCount: number): WebStoryDraft {
	const citations: DraftCitation[] = facts.map((fact, index) => ({
		marker: index + 1,
		fact_id: fact.id,
		claim: fact.claim,
		source_title: fact.sourceTitle,
		source_name: fact.sourceName,
		source_url: fact.sourceUrl,
		archive_snapshot_url: fact.archiveSnapshotUrl,
		content_hash: fact.contentHash,
		event_id: fact.eventId
	}));
	const headline = headlineFromFact(facts[0], storyId);
	const deck = `${facts[0].claim} [1]`;
	const bodySentences = facts.map((fact, index) => attributedSentence(fact, index + 1));
	const paragraphs: string[] = [];
	for (let index = 0; index < bodySentences.length; index += 2) {
		paragraphs.push(bodySentences.slice(index, index + 2).join(' '));
	}
	let markdown = expandTowardTarget([`# ${headline}`, '', `**${deck}**`, '', ...paragraphs], facts, targetWordCount);
	markdown = trimToTarget(markdown, targetWordCount);
	return {
		format: 'web_story_300',
		markdown,
		headline,
		word_count: wordCount(markdown),
		target_word_count: targetWordCount,
		citations,
		facts_used: citations.map((citation) => citation.fact_id)
	};
}

function expandTowardTarget(sections: string[], facts: DraftFact[], targetWordCount: number): string {
	let markdown = sections.join('\n\n');
	const minWords = Math.max(MIN_TARGET_WORDS, targetWordCount - 40);
	const maxWords = Math.max(targetWordCount + 40, MAX_TARGET_WORDS);
	if (wordCount(markdown) >= minWords) return markdown;
	const notes: string[] = [];
	for (let index = 0; index < facts.length; index += 1) {
		const fact = facts[index];
		notes.push(`Source note: ${fact.sourceTitle} supports the statement that ${stripTerminalPunctuation(fact.claim)}. [${index + 1}]`);
		const candidate = [...sections, '', '## Source Notes', '', notes.join(' ')].join('\n\n');
		const count = wordCount(candidate);
		if (count > maxWords && wordCount(markdown) >= minWords) break;
		markdown = candidate;
		if (count >= minWords) break;
	}
	return markdown;
}

function attributedSentence(fact: DraftFact, marker: number): string {
	const claim = sentenceCase(stripTerminalPunctuation(fact.claim));
	return `According to ${fact.sourceName}, ${claim}. [${marker}]`;
}

function headlineFromFact(fact: DraftFact | undefined, storyId: string): string {
	const claim = stripTerminalPunctuation(fact?.claim || storyId.replace(/[-_]+/g, ' '));
	const words = claim.split(/\s+/).filter(Boolean).slice(0, 12).join(' ');
	return sentenceCase(words || 'Draft story');
}

function trimToTarget(markdown: string, targetWordCount: number): string {
	const maxWords = Math.max(targetWordCount + 40, MAX_TARGET_WORDS);
	const words = markdown.split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return markdown;
	return `${words.slice(0, maxWords).join(' ').replace(/\s+\[\d+\]$/, '').trim()}.`;
}

function clampTargetWordCount(value: number | undefined): number {
	if (!Number.isFinite(value)) return DEFAULT_TARGET_WORDS;
	return Math.min(MAX_TARGET_WORDS, Math.max(MIN_TARGET_WORDS, Math.round(value as number)));
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function requiredText(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} is required`);
	return trimmed;
}

function stripTerminalPunctuation(value: string): string {
	return value.trim().replace(/[.!?]+$/, '');
}

function sentenceCase(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	return `${trimmed[0]?.toUpperCase() || ''}${trimmed.slice(1)}`;
}

function compactText(value: string, maxLength: number): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function wordCount(value: string): number {
	return value.split(/\s+/).filter((word) => /\w/.test(word)).length;
}

function sourceHost(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return value;
	}
}

function archiveFallbackUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'https://web.archive.org/';
		return `https://web.archive.org/web/*/${url.toString()}`;
	} catch {
		return 'https://web.archive.org/';
	}
}

function safeHttpUrl(value: string): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return url.toString();
	} catch {
		return null;
	}
}

function hashKey(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
	}
	return hash.toString(16);
}
