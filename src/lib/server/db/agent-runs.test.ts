import { describe, expect, it, vi } from 'vitest';
import type { AgentRunRecord } from './agent-runs';

vi.mock('./index', () => ({ db: {} }));
vi.mock('./schema', () => ({
	conversations: {},
	agentRunEvents: {},
	agentRuns: {},
	messages: {},
	messageProvenance: {}
}));

const { AGENT_MAX_ANSWER_CHARS, applyAgentRunEvent } = await import('./agent-runs');

describe('durable agent answer boundaries', () => {
	it('keeps the hard cap stable until terminal readable truncation', () => {
		const completeLine = 'The result is supported by the recorded source [1].';
		const run = {
			state: 'writing',
			answerText: '',
			sourcesJson: '[]',
			citationsJson: '[]',
			toolsJson: '[]',
			errorMessage: null
		} as AgentRunRecord;
		const content = `${completeLine}\n${'an incomplete continuation '.repeat(30_000)}`;

		const writingSnapshot = applyAgentRunEvent(
			run,
			'agent.answer.replace',
			JSON.stringify({ content })
		);
		const runFromSnapshot = (snapshot: ReturnType<typeof applyAgentRunEvent>): AgentRunRecord => ({
			...run,
			state: snapshot.state,
			answerText: snapshot.answerText,
			sourcesJson: JSON.stringify(snapshot.sources),
			citationsJson: JSON.stringify(snapshot.citations),
			toolsJson: JSON.stringify(snapshot.tools),
			errorMessage: snapshot.errorMessage
		});

		expect(writingSnapshot.answerText).toHaveLength(AGENT_MAX_ANSWER_CHARS);

		const afterLateDelta = applyAgentRunEvent(
			runFromSnapshot(writingSnapshot),
			'response.output_text.delta',
			JSON.stringify({ delta: 'late fragment must not re-enter the persisted answer' })
		);

		expect(afterLateDelta.answerText).toBe(writingSnapshot.answerText);
		expect(afterLateDelta.answerText).not.toContain('late fragment');

		const terminalSnapshot = applyAgentRunEvent(
			runFromSnapshot(afterLateDelta),
			'response.completed',
			JSON.stringify({ model: 'agent-fixture' })
		);

		expect(terminalSnapshot.state).toBe('complete');
		expect(terminalSnapshot.answerText.length).toBeLessThanOrEqual(AGENT_MAX_ANSWER_CHARS);
		expect(terminalSnapshot.answerText).toBe(completeLine);
	});
});
