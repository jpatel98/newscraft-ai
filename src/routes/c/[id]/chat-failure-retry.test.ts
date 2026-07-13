import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const threadSource = readFileSync(
	new URL('../../../lib/components/Thread.svelte', import.meta.url),
	'utf8'
);

	describe('chat failure retry UI', () => {
	it('renders safe stream failures without raw thrown details', () => {
		expect(pageSource).toContain(
			"import { streamFailureMessage, type StreamArgs } from '$lib/client/stream';"
		);
		expect(pageSource).toContain('const message = streamFailureMessage(e);');
		expect(pageSource).toContain('asstMsg.failure = { retryable: true };');
		expect(pageSource).not.toContain('String(e)');
		expect(pageSource).not.toContain("Couldn't reach the agent");
	});

	it('keeps a retry target and wires the Retry action', () => {
		expect(pageSource).toContain('type FailedSend = { args: RunStreamArgs };');
		expect(pageSource).toContain('document_ids: args.document_ids ? [...args.document_ids] : undefined');
		expect(pageSource).toContain('async function handleRetryFailure()');
		expect(pageSource).toContain("message.role === 'assistant' && message.partial");
		expect(pageSource).toContain('resume: true');
		expect(pageSource).toContain('message_id: resumable.id');
		expect(pageSource).toContain('...retry.args');
		expect(pageSource).toContain('await runStream(retry.args);');
		expect(pageSource).toContain('onRetryFailure={handleRetryFailure}');
		expect(threadSource).toContain('onRetryFailure?: () => void;');
		expect(threadSource).toContain('failure?.retryable');
		expect(threadSource).toContain('Retry');
		expect(threadSource).toContain('!failure &&');
		expect(threadSource).toContain("(m.role === 'assistant' || m.role === 'user')");
	});
});
