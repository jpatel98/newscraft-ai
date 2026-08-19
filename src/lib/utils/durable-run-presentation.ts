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
