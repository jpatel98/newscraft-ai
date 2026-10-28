export type DurableRunPresentation = {
	label: string;
	terminal: boolean;
	retryable: boolean;
};

export function durableRunPresentation(state: string | null | undefined): DurableRunPresentation | null {
	if (state === 'cancel_requested') return { label: 'Stopping', terminal: false, retryable: false };
	if (state === 'cancelled') return { label: 'Stopped', terminal: true, retryable: false };
	if (state === 'failed') return { label: 'Reply failed', terminal: true, retryable: true };
	return null;
}

const RAW_REASON_LIMIT = 200;

/**
 * Turns the worker's stored failure text into plain language for a producer.
 * Known worker messages are mapped to fixed copy; anything else falls back to
 * the raw message only when it is short and free of paths, tool ids and stack
 * traces, otherwise to nothing (the caller then shows only the state label).
 */
export function durableFailureReason(raw: string | null | undefined): string | null {
	const text = (raw ?? '').replace(/\s+/g, ' ').trim();
	if (!text) return null;
	if (/model request did not complete/i.test(text)) return 'The model did not respond in time.';
	if (/budget (?:was )?reached|budget was exhausted|reservation budget/i.test(text)) {
		return 'Research budget reached before an answer was written.';
	}
	if (
		/uncertain|cannot be repeated|will not be repeated|was not retried|not replayed|cancellation (?:is not|could not be) confirmed|cleanup/i.test(
			text
		)
	) {
		return 'An interrupted step could not be safely retried.';
	}
	if (/^(?:agent run failed|newscraft agent returned an error)\.?$/i.test(text)) {
		return 'The run stopped before an answer was written.';
	}
	if (
		text.length > RAW_REASON_LIMIT ||
		/traceback|stack trace|\bat\s+\S+:\d+|\bat\s+\S+\s*\(|(?:^|[\s("'])\/(?:Users|home|srv|var|opt|tmp|etc|usr)\//i.test(text) ||
		/\b(?:call|toolu|tool|run|msg)_[A-Za-z0-9]{6,}/.test(text) ||
		/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)
	) {
		return null;
	}
	return /[.!?]$/.test(text) ? text : `${text}.`;
}
