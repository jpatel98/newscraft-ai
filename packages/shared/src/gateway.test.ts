import { describe, expect, it } from 'vitest';
import {
	isCitationUrl,
	parseTranscriptCitationUrl,
	transcriptCitationUrl,
	transcriptClock
} from './gateway.js';

describe('transcript citation URLs', () => {
	it('round-trips a speaker turn', () => {
		const url = transcriptCitationUrl({ transcriptId: 'tr_abc', startMs: 134200, endMs: 141850 });
		expect(url).toBe('transcript://tr_abc#t=134200,141850');
		expect(parseTranscriptCitationUrl(url)).toEqual({ transcriptId: 'tr_abc', startMs: 134200, endMs: 141850 });
	});

	it('is accepted everywhere citation URLs are allowed', () => {
		expect(isCitationUrl('transcript://tr_abc#t=0,1200')).toBe(true);
		expect(isCitationUrl('TRANSCRIPT://tr_abc#t=0,1200')).toBe(true);
	});

	it('rounds and clamps times so end is never before start', () => {
		expect(transcriptCitationUrl({ transcriptId: 't', startMs: 10.6, endMs: 3 })).toBe('transcript://t#t=11,11');
		expect(transcriptCitationUrl({ transcriptId: 't', startMs: -5, endMs: 20 })).toBe('transcript://t#t=0,20');
	});

	it('rejects malformed or reversed references', () => {
		expect(parseTranscriptCitationUrl('transcript://t')).toBeNull();
		expect(parseTranscriptCitationUrl('transcript://t#t=5,3')).toBeNull();
		expect(parseTranscriptCitationUrl('transcript://t/x#t=1,2')).toBeNull();
		expect(parseTranscriptCitationUrl('https://example.com#t=1,2')).toBeNull();
	});

	it('encodes ids that are not URL-safe', () => {
		const url = transcriptCitationUrl({ transcriptId: 'a b#c', startMs: 0, endMs: 1 });
		expect(url).toBe('transcript://a%20b%23c#t=0,1');
		expect(parseTranscriptCitationUrl(url)?.transcriptId).toBe('a b#c');
	});

	it('prints producer-style timecodes', () => {
		expect(transcriptClock(0)).toBe('0:00');
		expect(transcriptClock(134200)).toBe('2:14');
		expect(transcriptClock(3_723_000)).toBe('1:02:03');
	});
});
