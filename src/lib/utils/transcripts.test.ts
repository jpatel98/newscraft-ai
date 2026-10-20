import { describe, expect, it } from 'vitest';
import { buildChatDraft, buildPlainText, buildSrt, CHAT_TRANSCRIPT_CHAR_LIMIT, exportBaseName, formatClock, speakerLabel, type TranscriptUtterance } from './transcripts';
import { mediaTypeFor, titleFromFileName } from './transcript-media';

const turns: TranscriptUtterance[] = [
	{ id: 'u1', speaker: 'speaker_0', start: 1500, end: 4200, text: 'We will table the budget Monday.', words: [] },
	{ id: 'u2', speaker: 'speaker_1', start: 3_725_010, end: 3_726_000, text: ' Is that final? ', words: [] },
	{ id: 'u3', speaker: 'speaker_1', start: 3_727_000, end: 3_727_000, text: '   ', words: [] }
];

describe('transcript text exports', () => {
	it('labels speakers by name or number', () => {
		expect(speakerLabel('speaker_0')).toBe('Speaker 1');
		expect(speakerLabel('speaker_1', { speaker_1: ' Mayor Chow ' })).toBe('Mayor Chow');
		expect(speakerLabel('speaker_2', { speaker_2: '  ' })).toBe('Speaker 3');
	});

	it('formats clock times', () => {
		expect(formatClock(7000)).toBe('0:07');
		expect(formatClock(765_000)).toBe('12:45');
		expect(formatClock(3_723_000)).toBe('1:02:03');
	});

	it('builds plain text and SRT, skipping empty turns', () => {
		const names = { speaker_0: 'Chow' };
		expect(buildPlainText(turns, names)).toBe('[0:01] Chow: We will table the budget Monday.\n\n[1:02:05] Speaker 2: Is that final?');
		expect(buildSrt(turns, names)).toBe(
			'1\n00:00:01,500 --> 00:00:04,200\nChow: We will table the budget Monday.\n\n2\n01:02:05,010 --> 01:02:06,000\nSpeaker 2: Is that final?\n'
		);
	});

	it('makes safe file names and clipped chat drafts', () => {
		expect(exportBaseName('Council: budget / Q&A')).toBe('Council-budget-QA');
		expect(exportBaseName('???')).toBe('transcript');
		const long = [{ ...turns[0], text: 'x'.repeat(CHAT_TRANSCRIPT_CHAR_LIMIT + 10) }];
		const draft = buildChatDraft('Presser', long);
		expect(draft.startsWith('Transcript: Presser\n\n')).toBe(true);
		expect(draft).toContain('[Transcript cut here.');
		expect(draft.length).toBeLessThan(CHAT_TRANSCRIPT_CHAR_LIMIT + 200);
	});
});

describe('media types', () => {
	it('uses the browser type when allowed, else the extension', () => {
		expect(mediaTypeFor('a.webm', 'audio/webm;codecs=opus')).toBe('audio/webm');
		expect(mediaTypeFor('Voice Memo.m4a', '')).toBe('audio/mp4');
		expect(mediaTypeFor('clip.MOV', 'application/octet-stream')).toBe('video/quicktime');
		expect(mediaTypeFor('notes.pdf', 'application/pdf')).toBeNull();
		expect(titleFromFileName('city_council_10-20.m4a')).toBe('city council 10-20');
	});
});
