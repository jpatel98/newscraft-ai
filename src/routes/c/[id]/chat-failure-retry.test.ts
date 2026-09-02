import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const threadSource = readFileSync(
	new URL('../../../lib/components/Thread.svelte', import.meta.url),
	'utf8'
);

describe('chat failure retry UI', () => {
	it('subscribes to a loaded durable run on refresh without posting a new run', () => {
		const connectStart = pageSource.indexOf('const connect = async () => {');
		const connectEnd = pageSource.indexOf('\n\t\t\t\t};', connectStart);
		const connectSource = pageSource.slice(connectStart, connectEnd);

		expect(connectSource).toContain('if (!attachedRun && !activeRunId)');
		expect(connectSource).toContain('await streamChat(requestArgs, callbacks);');
		expect(connectSource).toContain('await subscribeDurableRun(activeRunId as string, activeRunCursor, callbacks);');
		expect(pageSource).toContain('data.durableRun as DurableRunData');
		expect(connectSource.indexOf('await streamChat')).toBeLessThan(
			connectSource.indexOf('await subscribeDurableRun')
		);
	});

	it('updates the automatic title without reloading persisted messages during the active stream', () => {
		expect(pageSource).toContain('async function requestFirstPromptTitle(conversationId: string)');
		expect(pageSource).toContain('void requestFirstPromptTitle(meta.conversation_id);');
		const titleStart = pageSource.indexOf('async function requestFirstPromptTitle');
		const titleEnd = pageSource.indexOf('\n\tasync function executeStream', titleStart);
		const titleSource = pageSource.slice(titleStart, titleEnd);
		expect(titleSource).toContain('automaticTitle = title;');
		expect(titleSource).not.toContain('invalidateAll');
		expect(pageSource).toContain("const conversationTitle = $derived(automaticTitle ?? data.conversation.title);");
		expect(pageSource).toContain("<title>{conversationTitle || 'Untitled thread'} · NewsCraft</title>");
	});
	it('renders safe stream failures without raw thrown details', () => {
		expect(pageSource).toContain('const message = streamFailureMessage(e);');
		expect(pageSource).toContain('updateAssistantOverlay({ failure: { retryable: true } });');
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

	it('releases active composer state before best-effort reload on every stream terminal path', () => {
		expect(pageSource).toContain('onPartial: () => {');
		expect(pageSource).toContain(
			'updateAssistantOverlay({ partial: partialAnswer, streaming: false });'
		);
		const endStream = pageSource.indexOf('if (chat.abort === controller) chat.endStream();');
		const reload = pageSource.indexOf('await invalidateAll();', endStream);
		expect(endStream).toBeGreaterThanOrEqual(0);
		expect(reload).toBeGreaterThan(endStream);
	});
});
