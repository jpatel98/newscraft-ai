// The contract between the app and any agent backend. Backends report the
// contract version they speak and emit only the public events below; the app
// and browser depend on these names and tool kinds, never on internal tool
// names. services/hermes-chat/src/hermes_chat/public_events.py mirrors this
// file and a worker test fails if the two drift.

export const AGENT_CONTRACT_VERSION = 2;

/** Every event type a backend may store for the browser to replay. */
export const PUBLIC_AGENT_EVENTS = {
	runStarted: 'run.started',
	runFailed: 'run.failed',
	runCancelled: 'run.cancelled',
	plan: 'agent.plan',
	decision: 'agent.decision',
	toolProgress: 'agent.tool.progress',
	sourceFound: 'agent.source.found',
	sourceRead: 'agent.source.read',
	citations: 'agent.citations',
	answerDelta: 'response.output_text.delta',
	answerReplace: 'agent.answer.replace',
	artifactReady: 'artifact.ready',
	completed: 'response.completed',
	failed: 'response.failed'
} as const;

export type PublicAgentEventType = (typeof PUBLIC_AGENT_EVENTS)[keyof typeof PUBLIC_AGENT_EVENTS];

/** What a tool step does, independent of which tool or provider did it. */
export const AGENT_TOOL_KIND_LABELS = {
	search: { live: 'Scanning coverage', done: 'Coverage scanned' },
	read: { live: 'Reading source', done: 'Source read' },
	verify: { live: 'Checking facts', done: 'Facts checked' },
	cite: { live: 'Recording sources', done: 'Sources recorded' },
	publish: { live: 'Saving file', done: 'File saved' },
	files: { live: 'Checking files', done: 'Files checked' },
	compute: { live: 'Working with data', done: 'Data processed' },
	browse: { live: 'Reading source', done: 'Source read' },
	plan: { live: 'Planning research', done: 'Research planned' },
	decision: { live: 'Deciding next step', done: 'Next step decided' },
	tool: { live: 'Working on it', done: 'Tools used' }
} as const;

export type AgentToolKind = keyof typeof AGENT_TOOL_KIND_LABELS;

export function isAgentToolKind(value: unknown): value is AgentToolKind {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_TOOL_KIND_LABELS, value);
}

/** Kinds whose arguments (queries, URLs, titles) are public activity detail. */
export const PUBLIC_DETAIL_TOOL_KINDS: ReadonlySet<AgentToolKind> = new Set(['search', 'read', 'verify', 'browse']);

/** Kinds that are bookkeeping, not activity worth listing to a reader. */
export const HIDDEN_TOOL_KINDS: ReadonlySet<AgentToolKind> = new Set(['plan', 'decision']);

/** The `contract` block a backend reports from its readiness endpoint. */
export interface AgentContractReport {
	version: number;
	events?: string[];
	toolKinds?: string[];
}

/** True when a backend speaks the contract this app was built against. */
export function isAgentContractCompatible(report: unknown): report is AgentContractReport {
	if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
	return (report as { version?: unknown }).version === AGENT_CONTRACT_VERSION;
}
