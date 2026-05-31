type Role = 'user' | 'assistant' | 'system' | 'tool';

interface TextPart {
	type: 'text';
	text: string;
}
interface ImageUrlPart {
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
	/** JSON-encoded tool-call metadata captured while streaming, when available. */
	toolCalls?: string | null;
	/** True only for the message currently being streamed in the live overlay.
	 * Persisted partial messages have partial=1 but streaming=false. */
	streaming?: boolean;
}

type AgentCommandKind = 'builtin' | 'skill';

export interface AgentCommand {
	name: string;
	slash: string;
	description: string;
	category: string;
	argsHint?: string;
	kind: AgentCommandKind;
	enabled: boolean;
	blockedReason?: string | null;
}

export interface AgentSkillSummary {
	name: string;
	slash: string;
	description: string;
	category?: string | null;
	path: string;
	enabled: boolean;
}

export interface AgentSkillDetail extends AgentSkillSummary {
	frontmatter: Record<string, unknown>;
	content: string;
	supportingFiles: string[];
}

type ChannelSourceType = 'url';

export interface ChannelSource {
	id: string;
	type: ChannelSourceType;
	name: string;
	url: string;
	enabled: boolean;
	sortOrder: number;
}

export interface ChatCommand {
	slash: string;
	kind: AgentCommandKind;
	raw: string;
}

type ReasoningEffort = 'low' | 'medium' | 'high';

export interface AgentJob {
	id: string;
	workspaceId?: string | null;
	name: string;
	description?: string;
	prompt: string | null;
	scheduleDisplay: string;
	state: string;
	enabled: boolean;
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastStatus: string | null;
	lastError: string | null;
	lastDeliveryError: string | null;
	deliver: string | null;
	outputFormat?: string;
	sources?: ChannelSource[];
}

export interface AgentRunStep {
	id: string;
	type: string;
	label: string;
	status: string;
	startedAt?: string | null;
	completedAt?: string | null;
}

export interface AgentToolCall {
	id: string;
	name: string;
	status: string;
	startedAt?: string | null;
	completedAt?: string | null;
	error?: string | null;
}

export interface AgentRun {
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
	steps?: AgentRunStep[];
	toolCalls?: AgentToolCall[];
	sourceCount?: number;
	latestActivityAt?: string | null;
}

export interface BoardPost {
	id: string;
	jobId: string;
	channel: string;
	channelSlug: string;
	kind?: 'report' | 'run';
	runTime: string | null;
	schedule: string | null;
	filename: string;
	filePathDisplay?: string | null;
	responseMarkdown: string;
	preview: string;
	archived: boolean;
	runStatus?: string | null;
	elapsedMs?: number | null;
	lastError?: string | null;
}

export interface BoardChannel {
	slug: string;
	name: string;
	jobId?: string;
	active: boolean;
	state?: string | null;
	latestRunAt?: string | null;
	activeRun?: AgentRun | null;
	recentRun?: AgentRun | null;
	postCount: number;
}

export interface BoardData {
	channels: BoardChannel[];
	posts: BoardPost[];
	jobs: AgentJob[];
	runs?: AgentRun[];
	jobsError?: string | null;
}

export interface EditorialEvent {
	id: string;
	workspaceId: string;
	storyId: string | null;
	jobId: string | null;
	runId: string | null;
	agent: string;
	kind: string;
	payload: unknown;
	sources: unknown[];
	parentEventId: string | null;
	costMetadata: unknown;
	createdAt: string;
}

export interface OperatorFooterStatus {
	ok: boolean;
	generatedAt: string;
	gateway: {
		ok: boolean;
		status: number;
		label: string;
		detail: string | null;
	};
	agent: {
		available: boolean;
		label: string;
		detail: string | null;
	};
	lastSuccessfulMissionRun: {
		at: string | null;
		label: string;
		missionName: string | null;
	};
	database: {
		ok: boolean;
		label: string;
		detail: string | null;
	};
	pendingJobs: {
		count: number;
		label: string;
	};
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
