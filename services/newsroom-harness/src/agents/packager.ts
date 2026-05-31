import type { NewsroomEventJson, NewsroomGateDto } from '@newscraft/shared';
import { DEFAULT_WORKSPACE_ID, type HarnessRepository, type ScopedMemoryInspectDto } from '../db/repository.js';
import { newId, nowIso } from '../util/ids.js';

export type PackageOutputFormat =
	| 'brief'
	| 'web_story'
	| 'feature'
	| 'broadcast_script'
	| 'social_pack'
	| 'push'
	| 'newsletter_blurb'
	| 'headline_pack';

export interface PackagerInput {
	storyId: string;
	workspaceId?: string;
	jobId?: string | null;
	runId?: string | null;
	draftEventId?: string | null;
}

export interface PackageCitation {
	marker: number;
	fact_id: string;
	claim: string;
	source_title: string;
	source_name: string;
	source_url: string;
	archive_snapshot_url: string | null;
	content_hash: string | null;
	event_id: string | null;
}

export interface HeadlineOption {
	headline: string;
	rationale: string;
}

export interface HeadlinePack {
	general: HeadlineOption[];
	seo: HeadlineOption;
	social: HeadlineOption;
}

export interface SocialPack {
	x: string;
	bluesky: string;
	linkedin: string;
}

export interface PackageOutputs {
	brief: { markdown: string; word_count: number };
	web_story: { markdown: string; word_count: number };
	feature: { markdown: string; word_count: number; target_word_count: number };
	broadcast_script: { markdown: string };
	social_pack: SocialPack;
	push: { title: string; body: string };
	newsletter_blurb: { subject: string; markdown: string };
	headline_pack: HeadlinePack;
}

export interface StoryPackage {
	package_id: string;
	story_id: string;
	draft_event_id: string;
	draft_gate_id: string;
	approved_at: string;
	produced_at: string;
	headline: string;
	source_count: number;
	facts_used: string[];
	citations: PackageCitation[];
	outputs: PackageOutputs;
	package_event_id: string | null;
}

export interface PackagerRunResult {
	storyId: string;
	workspaceId: string;
	package: StoryPackage;
	gate: NewsroomGateDto;
}

interface DraftForPackage {
	markdown: string;
	headline: string;
	word_count: number;
	target_word_count: number | null;
	citations: PackageCitation[];
	facts_used: string[];
	event_id: string;
	created_at: string | null;
}

interface ApprovedDraft {
	draft: DraftForPackage;
	gate: NewsroomGateDto;
	approved_at: string;
}

interface PackageFact {
	id: string;
	claim: string;
	sourceTitle: string;
	sourceName: string;
	sourceUrl: string;
	archiveSnapshotUrl: string | null;
	contentHash: string | null;
	eventId: string | null;
	marker: number;
}

export class PackagerPreconditionError extends Error {}

export function runPackagerAgent(repository: HarnessRepository, input: PackagerInput): PackagerRunResult {
	const storyId = requiredText(input.storyId, 'story_id');
	const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
	const approved = latestApprovedDraft(repository, storyId, workspaceId, input.draftEventId);
	if (!approved) {
		throw new PackagerPreconditionError('Packaging requires an approved draft review gate for this story');
	}

	const memory = repository.inspectStoryMemory(storyId, workspaceId);
	const packageId = newId('pkg');
	const producedAt = nowIso();
	const packageFacts = packageFactsFor(memory, approved.draft);
	const outputs = buildPackageOutputs(approved.draft, packageFacts);
	const storyPackage: StoryPackage = {
		package_id: packageId,
		story_id: storyId,
		draft_event_id: approved.draft.event_id,
		draft_gate_id: approved.gate.id,
		approved_at: approved.approved_at,
		produced_at: producedAt,
		headline: approved.draft.headline,
		source_count: uniqueHosts(packageFacts.map((fact) => fact.sourceUrl)).length,
		facts_used: packageFacts.map((fact) => fact.id),
		citations: packageFacts.map((fact) => ({
			marker: fact.marker,
			fact_id: fact.id,
			claim: fact.claim,
			source_title: fact.sourceTitle,
			source_name: fact.sourceName,
			source_url: fact.sourceUrl,
			archive_snapshot_url: fact.archiveSnapshotUrl,
			content_hash: fact.contentHash,
			event_id: fact.eventId
		})),
		outputs,
		package_event_id: null
	};
	const event = repository.appendEvent({
		workspaceId,
		storyId,
		jobId: input.jobId,
		runId: input.runId,
		agent: 'packager',
		kind: 'package.produced',
		payload: storyPackage,
		sources: storyPackage.citations.map((citation) => ({
			url: citation.source_url,
			title: citation.source_title,
			fact_id: citation.fact_id,
			marker: citation.marker,
			archive_snapshot_url: citation.archive_snapshot_url,
			content_hash: citation.content_hash
		})),
		parentEventId: approved.draft.event_id,
		createdAt: producedAt
	});
	const storedPackage = { ...storyPackage, package_event_id: event.id };
	repository.appendStoryMemory(storyId, {
		workspaceId,
		key: 'package_history',
		kind: 'package.produced',
		actor: 'packager',
		createdAt: producedAt,
		value: storedPackage
	});
	const gate = repository.queueGate({
		workspace_id: workspaceId,
		story_id: storyId,
		job_id: input.jobId,
		run_id: input.runId,
		type: 'publish',
		title: `Publish package: ${approved.draft.headline}`,
		summary: 'Review the full package before any CMS, webhook, Slack, or email delivery action runs.',
		priority: 1,
		created_by: 'packager',
		actions: ['approve', 'hold', 'send_to_cms'],
		payload: {
			package_id: packageId,
			package_event_id: event.id,
			story_id: storyId,
			draft_event_id: approved.draft.event_id,
			draft_gate_id: approved.gate.id,
			headline: approved.draft.headline,
			formats: [
				'brief',
				'web_story',
				'feature',
				'broadcast_script',
				'social_pack',
				'push',
				'newsletter_blurb',
				'headline_pack'
			] satisfies PackageOutputFormat[],
			outputs: gatePreview(outputs)
		}
	});

	return { storyId, workspaceId, package: storedPackage, gate };
}

export function listStoryPackages(
	repository: HarnessRepository,
	storyId: string,
	workspaceId = DEFAULT_WORKSPACE_ID
): StoryPackage[] {
	return repository
		.inspectStoryMemory(storyId, workspaceId)
		.entries.filter((entry) => entry.key === 'package_history' && entry.kind === 'package.produced')
		.map((entry) => storyPackageFromValue(entry.value))
		.filter((pkg): pkg is StoryPackage => Boolean(pkg))
		.sort((left, right) => timestampMs(left.produced_at) - timestampMs(right.produced_at));
}

export function requireStoryPackage(
	repository: HarnessRepository,
	storyId: string,
	packageId: string,
	workspaceId = DEFAULT_WORKSPACE_ID
): StoryPackage {
	const pkg = listStoryPackages(repository, storyId, workspaceId).find((candidate) => candidate.package_id === packageId);
	if (!pkg) throw new PackagerPreconditionError('Package not found for this story');
	return pkg;
}

export function publishGateAllowsDelivery(
	repository: HarnessRepository,
	input: { storyId: string; workspaceId?: string; packageId: string }
): NewsroomGateDto | null {
	const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
	return (
		repository
			.listGates({ workspaceId, storyId: input.storyId, status: 'resolved', limit: 200 })
			.filter((gate) => gate.type === 'publish')
			.filter((gate) => {
				const payload = objectValue(gate.payload) ?? {};
				const action = gate.resolution?.action;
				return (
					stringValue(payload.package_id) === input.packageId &&
					(action === 'approve' || action === 'send_to_cms')
				);
			})
			.sort((left, right) => timestampMs(left.resolution?.resolved_at) - timestampMs(right.resolution?.resolved_at))
			.at(-1) ?? null
	);
}

function latestApprovedDraft(
	repository: HarnessRepository,
	storyId: string,
	workspaceId: string,
	draftEventId?: string | null
): ApprovedDraft | null {
	const memory = repository.inspectStoryMemory(storyId, workspaceId);
	const drafts = new Map<string, DraftForPackage>();
	for (const draft of draftCandidates(memory)) {
		const existing = drafts.get(draft.event_id);
		if (!existing || timestampMs(draft.created_at) >= timestampMs(existing.created_at)) {
			drafts.set(draft.event_id, draft);
		}
	}
	const approvals = repository
		.listGates({ workspaceId, storyId, status: 'resolved', limit: 200 })
		.filter((gate) => gate.type === 'draft_review' && gate.resolution?.action === 'approve')
		.flatMap((gate) => {
			const payload = objectValue(gate.payload) ?? {};
			const eventId = stringValue(payload.draft_event_id);
			const draft = eventId ? drafts.get(eventId) : null;
			if (!draft || (draftEventId && eventId !== draftEventId)) return [];
			return [{ draft, gate, approved_at: gate.resolution?.resolved_at || gate.created_at }];
		})
		.sort(
			(left, right) =>
				timestampMs(left.approved_at) - timestampMs(right.approved_at) ||
				timestampMs(left.draft.created_at) - timestampMs(right.draft.created_at)
		);
	return approvals.at(-1) ?? null;
}

function draftCandidates(memory: ScopedMemoryInspectDto): DraftForPackage[] {
	return [
		...memory.entries
			.filter((entry) => entry.key === 'draft_history')
			.map((entry) => draftFromValue(entry.value, stringValue(objectValue(entry.value)?.event_id), entry.created_at)),
		...(memory.agent_event_log || [])
			.filter((event) => event.kind === 'draft.produced')
			.map((event) => draftFromValue(event.payload, event.id, event.created_at))
	].filter((draft): draft is DraftForPackage => Boolean(draft));
}

function draftFromValue(value: unknown, eventId: string | null, createdAt: string | null): DraftForPackage | null {
	const raw = objectValue(value);
	if (!raw || !eventId) return null;
	const markdown = stringValue(raw.draft_markdown) || stringValue(raw.draftMarkdown) || stringValue(raw.markdown);
	if (!markdown) return null;
	const headline = stringValue(raw.headline) || headlineFromMarkdown(markdown);
	return {
		markdown,
		headline,
		word_count: numberValue(raw.word_count) ?? wordCount(markdown),
		target_word_count: numberValue(raw.target_word_count),
		citations: arrayValue(raw.citations).map(citationFromValue).filter((citation): citation is PackageCitation => Boolean(citation)),
		facts_used: stringArray(raw.facts_used),
		event_id: eventId,
		created_at: createdAt
	};
}

function packageFactsFor(memory: ScopedMemoryInspectDto, draft: DraftForPackage): PackageFact[] {
	const facts = new Map<string, PackageFact>();
	let marker = 1;
	for (const citation of draft.citations) {
		if (!safeHttpUrl(citation.source_url)) continue;
		facts.set(citation.fact_id, {
			id: citation.fact_id,
			claim: citation.claim,
			sourceTitle: citation.source_title,
			sourceName: citation.source_name,
			sourceUrl: citation.source_url,
			archiveSnapshotUrl: citation.archive_snapshot_url,
			contentHash: citation.content_hash,
			eventId: citation.event_id,
			marker: citation.marker || marker++
		});
	}
	for (const value of memory.current.fact_ledger || []) {
		const fact = factFromValue(value, marker);
		if (!fact || facts.has(fact.id)) continue;
		facts.set(fact.id, fact);
		marker = Math.max(marker, fact.marker + 1);
	}
	return [...facts.values()].sort((left, right) => left.marker - right.marker);
}

function factFromValue(value: NewsroomEventJson, marker: number): PackageFact | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const status = (
		stringValue(raw.status) ||
		stringValue(raw.verification_status) ||
		stringValue(raw.verificationStatus) ||
		stringValue(raw.state)
	).toLowerCase();
	if (!['verified', 'source_backed', 'source-backed'].includes(status)) return null;
	const claim =
		stringValue(raw.claim) ||
		stringValue(raw.text) ||
		stringValue(raw.sentence) ||
		stringValue(raw.detail) ||
		stringValue(raw.summary);
	if (!claim) return null;
	const source = sourceFromValue(raw);
	if (!source) return null;
	const id = stringValue(raw.id) || stringValue(raw.claim_id) || stringValue(raw.fact_id) || `fact-${hashText(claim)}`;
	return {
		id,
		claim: compactText(claim, 500),
		sourceTitle: source.title,
		sourceName: source.name,
		sourceUrl: source.url,
		archiveSnapshotUrl: source.archiveSnapshotUrl,
		contentHash: source.contentHash,
		eventId: stringValue(raw.event_id),
		marker
	};
}

function buildPackageOutputs(draft: DraftForPackage, facts: PackageFact[]): PackageOutputs {
	const headlinePack = buildHeadlinePack(draft.headline, facts);
	const brief = briefText(draft, facts);
	const feature = featureText(draft, facts);
	const broadcast = broadcastScript(draft, facts);
	const social = socialPack(draft, facts);
	const push = pushCopy(draft, brief);
	const newsletter = newsletterBlurb(draft, brief, facts);
	return {
		brief: { markdown: brief, word_count: wordCount(brief) },
		web_story: { markdown: draft.markdown, word_count: draft.word_count || wordCount(draft.markdown) },
		feature: { markdown: feature, word_count: wordCount(feature), target_word_count: 800 },
		broadcast_script: { markdown: broadcast },
		social_pack: social,
		push,
		newsletter_blurb: newsletter,
		headline_pack: headlinePack
	};
}

function briefText(draft: DraftForPackage, facts: PackageFact[]): string {
	const factLines = facts.slice(0, 3).map((fact) => `${stripTerminalPunctuation(fact.claim)} [${fact.marker}]`);
	const text = [draft.headline, ...factLines].join('. ');
	return trimToWordRange(text, 45, 72);
}

function featureText(draft: DraftForPackage, facts: PackageFact[]): string {
	const title = draft.headline;
	const sourceParagraphs = facts.map((fact) => attributedSentence(fact));
	const sections = [
		`# ${title}`,
		'## What happened',
		...paragraphGroups(sourceParagraphs, 2),
		'## Why it matters',
		...paragraphGroups(
			facts.map((fact) => `The confirmed record also shows that ${stripTerminalPunctuation(fact.claim)}. [${fact.marker}]`),
			2
		),
		'## What editors can publish from',
		...paragraphGroups(
			facts.map(
				(fact) =>
					`${fact.sourceName} is the cited support for this point, with the package retaining the source URL, archive fallback, and content hash where available. [${fact.marker}]`
			),
			2
		)
	];
	return expandFeature(sections.join('\n\n'), facts);
}

function broadcastScript(draft: DraftForPackage, facts: PackageFact[]): string {
	const topFacts = facts.slice(0, 5);
	return [
		`ANCHOR INTRO: ${draft.headline}.`,
		'',
		'SCRIPT:',
		...topFacts.map((fact) => `${fact.sourceName} says ${stripTerminalPunctuation(fact.claim)}. [${fact.marker}]`),
		'',
		'EDITOR NOTE: Confirm the publish gate is resolved before this script leaves NewsCraft.'
	].join('\n');
}

function socialPack(draft: DraftForPackage, facts: PackageFact[]): SocialPack {
	const lead = stripTerminalPunctuation(facts[0]?.claim || draft.headline);
	const source = facts[0]?.sourceName ? ` Source: ${facts[0].sourceName}.` : '';
	return {
		x: trimText(`${draft.headline}: ${lead}.${source}`, 260),
		bluesky: trimText(`${draft.headline}\n\n${lead}.${source}`, 290),
		linkedin: trimText(`${draft.headline}\n\n${lead}. The full package keeps citations and editor approval attached before delivery.`, 620)
	};
}

function pushCopy(draft: DraftForPackage, brief: string): { title: string; body: string } {
	return {
		title: trimText(draft.headline, 64),
		body: trimText(stripMarkdown(brief), 140)
	};
}

function newsletterBlurb(draft: DraftForPackage, brief: string, facts: PackageFact[]): { subject: string; markdown: string } {
	const sourceNote =
		facts.length > 0
			? `\n\nSource note: ${facts
					.slice(0, 3)
					.map((fact) => `${fact.sourceName} [${fact.marker}]`)
					.join(', ')}.`
			: '';
	return {
		subject: trimText(draft.headline, 80),
		markdown: `${brief}${sourceNote}`
	};
}

function buildHeadlinePack(headline: string, facts: PackageFact[]): HeadlinePack {
	const subject = headlineSubject(headline, facts);
	const sourceRationale = 'Uses source-backed facts from the approved draft and keeps claims behind editor approval.';
	return {
		general: [
			{ headline: trimText(headline, 96), rationale: 'Carries the approved draft headline forward.' },
			{ headline: trimText(`${subject}: what to know now`, 96), rationale: sourceRationale },
			{ headline: trimText(`Key takeaways from ${subject}`, 96), rationale: 'Frames the package for scanning without adding new claims.' },
			{ headline: trimText(`Why ${subject} matters now`, 96), rationale: 'Connects the angle to the package brief and fact ledger.' },
			{ headline: trimText(`The latest on ${subject}`, 96), rationale: 'Works as a restrained update headline for general channels.' }
		],
		seo: {
			headline: trimText(`${subject}: latest facts, sources, and what to know`, 70),
			rationale: 'Includes the subject and plain-language search terms while avoiding unsupported specifics.'
		},
		social: {
			headline: trimText(`${subject}: the source-backed update`, 90),
			rationale: 'Signals source-backed verification value for social channels without overstating the story.'
		}
	};
}

function gatePreview(outputs: PackageOutputs): Record<string, NewsroomEventJson> {
	return {
		brief: outputs.brief.markdown,
		headlines: outputs.headline_pack.general.map((option) => option.headline),
		seo_headline: outputs.headline_pack.seo.headline,
		social_headline: outputs.headline_pack.social.headline,
		push: outputs.push,
		newsletter_subject: outputs.newsletter_blurb.subject
	};
}

function storyPackageFromValue(value: unknown): StoryPackage | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const packageId = stringValue(raw.package_id);
	const storyId = stringValue(raw.story_id);
	const draftEventId = stringValue(raw.draft_event_id);
	const draftGateId = stringValue(raw.draft_gate_id);
	const outputs = objectValue(raw.outputs);
	if (!packageId || !storyId || !draftEventId || !draftGateId || !outputs) return null;
	return raw as unknown as StoryPackage;
}

function citationFromValue(value: unknown): PackageCitation | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const sourceUrl = safeHttpUrl(stringValue(raw.source_url) || stringValue(raw.sourceUrl));
	const factId = stringValue(raw.fact_id) || stringValue(raw.factId);
	const claim = stringValue(raw.claim);
	if (!sourceUrl || !factId || !claim) return null;
	return {
		marker: numberValue(raw.marker) ?? 1,
		fact_id: factId,
		claim,
		source_title: stringValue(raw.source_title) || stringValue(raw.sourceTitle) || sourceHost(sourceUrl),
		source_name: stringValue(raw.source_name) || stringValue(raw.sourceName) || sourceHost(sourceUrl),
		source_url: sourceUrl,
		archive_snapshot_url: safeHttpUrl(stringValue(raw.archive_snapshot_url) || stringValue(raw.archiveSnapshotUrl)),
		content_hash: stringValue(raw.content_hash) || stringValue(raw.contentHash),
		event_id: stringValue(raw.event_id) || stringValue(raw.eventId)
	};
}

function sourceFromValue(
	raw: Record<string, unknown>
): { title: string; name: string; url: string; archiveSnapshotUrl: string | null; contentHash: string | null } | null {
	for (const candidate of [...arrayValue(raw.sources), ...arrayValue(raw.source_set), ...arrayValue(raw.sourceSet)]) {
		const source = objectValue(candidate);
		if (!source) continue;
		const url = safeHttpUrl(stringValue(source.url) || stringValue(source.source_url) || stringValue(source.sourceUrl));
		if (!url) continue;
		return {
			url,
			title: stringValue(source.title) || stringValue(source.source_title) || sourceHost(url),
			name: stringValue(source.name) || stringValue(source.source_name) || sourceHost(url),
			archiveSnapshotUrl: safeHttpUrl(
				stringValue(source.archive_snapshot_url) ||
					stringValue(source.archiveSnapshotUrl) ||
					stringValue(source.archive_url) ||
					stringValue(source.archiveUrl)
			),
			contentHash: stringValue(source.content_hash) || stringValue(source.contentHash)
		};
	}
	const url =
		safeHttpUrl(stringValue(raw.source_url) || stringValue(raw.sourceUrl) || stringValue(raw.url)) ||
		safeHttpUrl(stringValue(objectValue(raw.provenance)?.url));
	if (!url) return null;
	return {
		url,
		title: stringValue(raw.source_title) || stringValue(raw.sourceTitle) || sourceHost(url),
		name: stringValue(raw.source_name) || stringValue(raw.sourceName) || sourceHost(url),
		archiveSnapshotUrl: safeHttpUrl(
			stringValue(raw.archive_snapshot_url) ||
				stringValue(raw.archiveSnapshotUrl) ||
				stringValue(objectValue(raw.provenance)?.archive_snapshot_url) ||
				stringValue(objectValue(raw.provenance)?.archiveSnapshotUrl)
		),
		contentHash:
			stringValue(raw.content_hash) ||
			stringValue(raw.contentHash) ||
			stringValue(objectValue(raw.provenance)?.content_hash) ||
			stringValue(objectValue(raw.provenance)?.contentHash)
	};
}

function attributedSentence(fact: PackageFact): string {
	return `According to ${fact.sourceName}, ${stripTerminalPunctuation(fact.claim)}. [${fact.marker}]`;
}

function expandFeature(markdown: string, facts: PackageFact[]): string {
	let expanded = markdown;
	const notes = facts.map(
		(fact) =>
			`For packaging, this point remains tied to ${fact.sourceName}; editors can inspect citation [${fact.marker}] before publication.`
	);
	let noteIndex = 0;
	while (wordCount(expanded) < 720 && notes.length > 0) {
		expanded = `${expanded}\n\n${notes[noteIndex % notes.length]}`;
		noteIndex += 1;
		if (noteIndex > notes.length * 8) break;
	}
	return trimWords(expanded, 880);
}

function trimToWordRange(value: string, minWords: number, maxWords: number): string {
	let text = value.replace(/\s+/g, ' ').trim();
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length > maxWords) return `${words.slice(0, maxWords).join(' ').replace(/[,:;]+$/, '').trim()}.`;
	if (words.length >= minWords) return text;
	const suffix = 'The package keeps every publishable line tied to the approved draft and its source-backed fact ledger.';
	text = `${text}. ${suffix}`;
	return trimWords(text, maxWords);
}

function trimWords(value: string, maxWords: number): string {
	const words = value.split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return value;
	return `${words.slice(0, maxWords).join(' ').replace(/[,:;]+$/, '').trim()}.`;
}

function paragraphGroups(values: string[], size: number): string[] {
	const groups: string[] = [];
	for (let index = 0; index < values.length; index += size) {
		groups.push(values.slice(index, index + size).join(' '));
	}
	return groups;
}

function headlineFromMarkdown(markdown: string): string {
	return (
		markdown
			.split(/\n+/)
			.map((line) => line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim())
			.find(Boolean) || 'Packaged story'
	);
}

function headlineSubject(headline: string, facts: PackageFact[]): string {
	const base = stripTerminalPunctuation(headline || facts[0]?.claim || 'this story');
	return trimText(base.replace(/^the latest on\s+/i, ''), 52).replace(/[.!?]+$/, '');
}

function stripMarkdown(value: string): string {
	return value
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\*\*/g, '')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

function compactText(value: string, maxLength: number): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function trimText(value: string, maxLength: number): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function stripTerminalPunctuation(value: string): string {
	return value.trim().replace(/[.!?]+$/, '');
}

function wordCount(value: string): number {
	return value.split(/\s+/).filter((word) => /\w/.test(word)).length;
}

function uniqueHosts(urls: string[]): string[] {
	return [...new Set(urls.map(sourceHost).filter(Boolean))];
}

function sourceHost(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return value;
	}
}

function safeHttpUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return url.toString();
	} catch {
		return null;
	}
}

function timestampMs(value: string | null | undefined): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

function hashText(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
	}
	return hash.toString(16);
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.flatMap((candidate) => {
				const text = stringValue(candidate);
				return text ? [text] : [];
			})
		: [];
}

function numberValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function requiredText(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} is required`);
	return trimmed;
}
