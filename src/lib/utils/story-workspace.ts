import type { ChannelSource } from '$lib/types';

export type PitchGateResolution = 'accepted' | 'held' | 'spiked';

export interface WorkspacePitch {
	id: string;
	beat: string;
	title: string;
	angle: string;
	whyNow: string;
	confidence: number;
	confidenceLabel: string;
	sources: ChannelSource[];
	runTime: string | null;
	report: string;
}

export interface WorkspaceFact {
	id: string;
	label: string;
	detail: string;
	sourceName?: string;
	sourceUrl?: string;
}

export interface WorkspaceEvent {
	id: string;
	kind: string;
	label: string;
	detail: string;
	at: string;
	tone: 'neutral' | 'active' | 'warning';
}

export type WorkspaceActivity = WorkspaceEvent;

export interface StoryWorkspace {
	id: string;
	pitchId: string;
	beat: string;
	title: string;
	angle: string;
	whyNow: string;
	confidenceLabel: string;
	sources: ChannelSource[];
	createdAt: string;
	status: 'active';
	factLedger: WorkspaceFact[];
	draft: string;
	eventLog: WorkspaceEvent[];
	activity: WorkspaceActivity[];
}

function timestamp(now?: string): string {
	return now ?? new Date().toISOString();
}

export function createGateEvent(
	pitch: WorkspacePitch,
	resolution: PitchGateResolution,
	now?: string
): WorkspaceEvent {
	const createdAt = timestamp(now);
	return {
		id: `pitch-${pitch.id}-${resolution}-${createdAt}`,
		kind: 'pitch-gate',
		label: `Pitch ${resolution}`,
		detail: `${pitch.title} was ${resolution}.`,
		at: createdAt,
		tone: resolution === 'accepted' ? 'active' : resolution === 'spiked' ? 'warning' : 'neutral'
	};
}

function createFactLedger(pitch: WorkspacePitch): WorkspaceFact[] {
	const facts: WorkspaceFact[] = [
		{
			id: `fact-${pitch.id}-angle`,
			label: 'Working angle',
			detail: pitch.angle
		},
		{
			id: `fact-${pitch.id}-why-now`,
			label: 'Why now',
			detail: pitch.whyNow
		}
	];

	for (const [index, source] of pitch.sources.entries()) {
		facts.push({
			id: `fact-${pitch.id}-source-${source.id || index}`,
			label: `Source ${index + 1}`,
			detail: source.name,
			sourceName: source.name,
			sourceUrl: source.url
		});
	}

	return facts;
}

export function createStoryWorkspace(pitch: WorkspacePitch, now?: string): StoryWorkspace {
	const createdAt = timestamp(now);
	const sourceLabel = `${pitch.sources.length} source${pitch.sources.length === 1 ? '' : 's'}`;
	return {
		id: `story-${pitch.id}`,
		pitchId: pitch.id,
		beat: pitch.beat,
		title: pitch.title,
		angle: pitch.angle,
		whyNow: pitch.whyNow,
		confidenceLabel: pitch.confidenceLabel,
		sources: pitch.sources,
		createdAt,
		status: 'active',
		factLedger: createFactLedger(pitch),
		draft: `Draft workspace for "${pitch.title}".`,
		eventLog: [
			createGateEvent(pitch, 'accepted', createdAt),
			{
				id: `workspace-${pitch.id}-created-${createdAt}`,
				kind: 'workspace-created',
				label: 'Story workspace created',
				detail: 'Fact ledger, draft canvas, event wire, and agent activity are ready.',
				at: createdAt,
				tone: 'active'
			}
		],
		activity: [
			{
				id: `activity-${pitch.id}-assignment-${createdAt}`,
				kind: 'assignment-desk',
				label: 'Assignment Desk',
				detail: 'Accepted the pitch and opened the story workspace.',
				at: createdAt,
				tone: 'active'
			},
			{
				id: `activity-${pitch.id}-research-${createdAt}`,
				kind: 'research-desk',
				label: 'Research Desk',
				detail: `${sourceLabel} attached for the first source pass.`,
				at: createdAt,
				tone: 'neutral'
			}
		]
	};
}
