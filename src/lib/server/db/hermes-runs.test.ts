import { describe, expect, it, vi } from 'vitest';
import type { HermesRunRecord } from './hermes-runs';

vi.mock('./index', () => ({ db: {} }));
vi.mock('./schema', () => ({
	conversations: {},
	hermesRunEvents: {},
	hermesRuns: {},
	messages: {},
	messageProvenance: {}
}));

const { HERMES_MAX_ANSWER_CHARS, applyHermesRunEvent } = await import('./hermes-runs');

describe('durable Hermes answer boundaries', () => {
	it('keeps the hard cap stable until terminal readable truncation', () => {
		const completeLine = 'The result is supported by the recorded source [1].';
		const run = {
			state: 'writing',
			answerText: '',
			sourcesJson: '[]',
			citationsJson: '[]',
			toolsJson: '[]',
			errorMessage: null
		} as HermesRunRecord;
		const content = `${completeLine}\n${'an incomplete continuation '.repeat(30_000)}`;

		const writingSnapshot = applyHermesRunEvent(
			run,
			'agent.answer.replace',
			JSON.stringify({ content })
		);
		const runFromSnapshot = (snapshot: ReturnType<typeof applyHermesRunEvent>): HermesRunRecord => ({
			...run,
			state: snapshot.state,
			answerText: snapshot.answerText,
			sourcesJson: JSON.stringify(snapshot.sources),
			citationsJson: JSON.stringify(snapshot.citations),
			toolsJson: JSON.stringify(snapshot.tools),
			errorMessage: snapshot.errorMessage
		});

		expect(writingSnapshot.answerText).toHaveLength(HERMES_MAX_ANSWER_CHARS);

		const afterLateDelta = applyHermesRunEvent(
			runFromSnapshot(writingSnapshot),
			'response.output_text.delta',
			JSON.stringify({ delta: 'late fragment must not re-enter the persisted answer' })
		);

		expect(afterLateDelta.answerText).toBe(writingSnapshot.answerText);
		expect(afterLateDelta.answerText).not.toContain('late fragment');

		const terminalSnapshot = applyHermesRunEvent(
			runFromSnapshot(afterLateDelta),
			'response.completed',
			JSON.stringify({ model: 'hermes-fixture' })
		);

		expect(terminalSnapshot.state).toBe('complete');
		expect(terminalSnapshot.answerText.length).toBeLessThanOrEqual(HERMES_MAX_ANSWER_CHARS);
		expect(terminalSnapshot.answerText).toBe(completeLine);
	});
});
