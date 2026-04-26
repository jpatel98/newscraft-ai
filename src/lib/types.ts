export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface TextPart {
	type: 'text';
	text: string;
}
export interface ImageUrlPart {
	type: 'image_url';
	image_url: { url: string };
}
export type ContentPart = TextPart | ImageUrlPart;

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
	id: string;
	role: Role;
	content: MessageContent;
	partial: boolean;
	createdAt?: number;
	/** True only for the message currently being streamed in the live overlay.
	 * Persisted partial messages have partial=1 but streaming=false. */
	streaming?: boolean;
}

export type HermesCommandKind = 'builtin' | 'skill';

export interface HermesCommand {
	name: string;
	slash: string;
	description: string;
	category: string;
	argsHint?: string;
	kind: HermesCommandKind;
	enabled: boolean;
	blockedReason?: string | null;
}

export interface HermesSkillSummary {
	name: string;
	slash: string;
	description: string;
	category?: string | null;
	path: string;
	enabled: boolean;
}

export interface HermesSkillDetail extends HermesSkillSummary {
	frontmatter: Record<string, unknown>;
	content: string;
	supportingFiles: string[];
}

export interface ChatCommand {
	slash: string;
	kind: HermesCommandKind;
	raw: string;
}

export interface HermesJob {
	id: string;
	name: string;
	scheduleDisplay: string;
	state: string;
	enabled: boolean;
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastStatus: string | null;
	lastError: string | null;
	lastDeliveryError: string | null;
	deliver: string | null;
}

export interface HermesRun {
	id: string;
	jobId: string;
	jobName?: string | null;
	status: 'queued' | 'running' | 'completed' | 'failed' | string;
	queuedAt?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
	updatedAt?: string | null;
	elapsedMs?: number | null;
	lastError?: string | null;
}

export interface BoardPost {
	id: string;
	jobId: string;
	channel: string;
	channelSlug: string;
	runTime: string | null;
	schedule: string | null;
	filename: string;
	responseMarkdown: string;
	preview: string;
	archived: boolean;
}

export interface BoardChannel {
	slug: string;
	name: string;
	jobId?: string;
	active: boolean;
	state?: string | null;
	latestRunAt?: string | null;
	activeRun?: HermesRun | null;
	recentRun?: HermesRun | null;
	postCount: number;
}

export interface BoardData {
	channels: BoardChannel[];
	posts: BoardPost[];
	jobs: HermesJob[];
	runs?: HermesRun[];
	jobsError?: string | null;
}

/** Plain-text projection of a message for callers that don't render parts (copy, recall, etc.). */
export function contentText(c: MessageContent): string {
	if (typeof c === 'string') return c;
	return c
		.filter((p): p is TextPart => p.type === 'text')
		.map((p) => p.text)
		.join('\n')
		.trim();
}

/** Tally non-text parts so call sites can branch on "has images". */
export function hasImageParts(c: MessageContent): boolean {
	return Array.isArray(c) && c.some((p) => p.type === 'image_url');
}
