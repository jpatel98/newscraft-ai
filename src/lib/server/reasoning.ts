import { getSetting, setSetting } from '$lib/server/db';

export type ReasoningEffort = 'low' | 'medium' | 'high';

const VALUES = new Set<ReasoningEffort>(['low', 'medium', 'high']);

function key(conversationId: string): string {
	return `conversation.${conversationId}.reasoning_effort`;
}

export function parseReasoningEffort(value: string): ReasoningEffort | 'default' | null {
	const normalized = value.trim().toLowerCase();
	if (!normalized) return null;
	if (normalized === 'default' || normalized === 'reset' || normalized === 'auto') return 'default';
	return VALUES.has(normalized as ReasoningEffort) ? (normalized as ReasoningEffort) : null;
}

export function getConversationReasoningEffort(conversationId: string): ReasoningEffort | undefined {
	const value = getSetting(key(conversationId));
	if (!value) return undefined;
	return VALUES.has(value as ReasoningEffort) ? (value as ReasoningEffort) : undefined;
}

export function setConversationReasoningEffort(
	conversationId: string,
	effort: ReasoningEffort | 'default'
): ReasoningEffort | undefined {
	if (effort === 'default') {
		setSetting(key(conversationId), '');
		return undefined;
	}
	setSetting(key(conversationId), effort);
	return effort;
}

export function reasoningEffortLabel(effort: ReasoningEffort | undefined): string {
	return effort ? effort[0].toUpperCase() + effort.slice(1) : 'Default';
}
