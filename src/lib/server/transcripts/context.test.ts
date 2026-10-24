import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db/transcripts', () => ({ listConversationTranscripts: vi.fn() }));

import { buildTranscriptContext, mergeTurns } from './context';

const utter = (id: string, speaker: string, start: number, end: number, text: string) => ({
	id, speaker, start, end, text, words: []
});

const tape = (id: string, utterances: ReturnType<typeof utter>[], speakerNames: Record<string, string> = {}) => ({
	id, title: `Tape ${id}`, durationMs: 60_000, utterances, speakerNames
});

describe('buildTranscriptContext', () => {
	it('names speakers, trims text and drops empty turns', () => {
		const { transcripts, truncated } = buildTranscriptContext([
			tape('a', [
				utter('u1', 'speaker_0', 0, 1500.4, '  Is the bridge   closing? '),
				utter('u2', 'speaker_1', 1600, 4000, 'It closes Monday.'),
				utter('u3', 'speaker_1', 4100, 4200, '   ')
			], { speaker_1: 'Mayor Brown' })
		]);
		expect(truncated).toEqual({});
		expect(transcripts).toEqual([
			{
				id: 'a', title: 'Tape a', durationMs: 60_000,
				turns: [
					{ id: 'u1', speaker: 'Speaker 1', startMs: 0, endMs: 1500, text: 'Is the bridge closing?' },
					{ id: 'u2', speaker: 'Mayor Brown', startMs: 1600, endMs: 4000, text: 'It closes Monday.' }
				]
			}
		]);
	});

	it('cuts the tail when the turn budget runs out and says how much', () => {
		// Alternating speakers so nothing merges.
		const long = tape('b', Array.from({ length: 6 }, (_, i) => utter(`u${i}`, `speaker_${i % 2}`, i * 1000, i * 1000 + 900, `turn ${i}`)));
		const { transcripts, truncated } = buildTranscriptContext([long], { turnLimit: 4 });
		expect(transcripts[0].turns.map((turn) => turn.id)).toEqual(['u0', 'u1', 'u2', 'u3']);
		expect(truncated).toEqual({ b: 2 });
	});

	it('spends the character budget across transcripts in attachment order', () => {
		const first = tape('first', [utter('f1', 's', 0, 1, 'x'.repeat(50))]);
		const second = tape('second', [utter('s1', 'a', 0, 1, 'y'.repeat(40)), utter('s2', 'b', 2, 3, 'z'.repeat(40))]);
		const { transcripts, truncated } = buildTranscriptContext([first, second], { charLimit: 100 });
		expect(transcripts.map((t) => t.id)).toEqual(['first', 'second']);
		expect(transcripts[1].turns).toHaveLength(1);
		expect(truncated).toEqual({ second: 1 });
	});

	it('omits a transcript whose turns are all empty', () => {
		const { transcripts } = buildTranscriptContext([tape('empty', [utter('e', 's', 0, 1, '')])]);
		expect(transcripts).toEqual([]);
	});

	it('merges one speaker\'s consecutive fragments into a turn and keeps the first start and last end', () => {
		const merged = mergeTurns([
			{ id: 'a', speaker: 'Mayor', startMs: 0, endMs: 2000, text: 'The bridge closes Monday' },
			{ id: 'b', speaker: 'Mayor', startMs: 2300, endMs: 5000, text: 'and stays closed for eight months.' },
			{ id: 'c', speaker: 'Reporter', startMs: 5200, endMs: 6000, text: 'Why?' },
			{ id: 'd', speaker: 'Mayor', startMs: 6100, endMs: 8000, text: 'The welds.' },
			{ id: 'e', speaker: 'Mayor', startMs: 12_000, endMs: 13_000, text: 'That is all.' }
		]);
		expect(merged).toEqual([
			{ id: 'a', speaker: 'Mayor', startMs: 0, endMs: 5000, text: 'The bridge closes Monday and stays closed for eight months.' },
			{ id: 'c', speaker: 'Reporter', startMs: 5200, endMs: 6000, text: 'Why?' },
			{ id: 'd', speaker: 'Mayor', startMs: 6100, endMs: 8000, text: 'The welds.' },
			{ id: 'e', speaker: 'Mayor', startMs: 12_000, endMs: 13_000, text: 'That is all.' }
		]);
	});

	it('stops merging once a turn would run past 20 seconds', () => {
		const long = Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, speaker: 'S', startMs: i * 5000, endMs: i * 5000 + 4500, text: `part ${i}` }));
		const merged = mergeTurns(long);
		expect(merged.map((turn) => [turn.startMs, turn.endMs])).toEqual([[0, 19_500], [20_000, 29_500]]);
	});
});
