import type { NewsroomJobDto } from '@newscraft/shared';
import { describe, expect, it } from 'vitest';
import { wrapMissionReport } from '../src/jobs/report.js';
import { assessReportQuality } from '../src/util/report-quality.js';

const job: NewsroomJobDto = {
	id: 'job-123',
	name: 'Morning Watch',
	title: 'Morning Watch',
	description: '',
	prompt: 'Scan the latest local headlines.',
	schedule: 'every 60m',
	cron: '*/60 * * * *',
	schedule_display: 'every 60m',
	enabled: true,
	state: 'scheduled',
	next_run_at: null,
	last_run_at: null,
	last_status: null,
	last_error: null,
	deliver: 'database',
	output_format: 'markdown',
	created_at: '2026-05-22T10:00:00.000Z',
	updated_at: '2026-05-22T10:00:00.000Z'
};

describe('research update quality checks', () => {
	it('replaces looping repeated output before saving the research update body', () => {
		const repeatedBlock = `## Source Notes

Source: Local feed
Report text: City desk confirms river inspection. Officials scheduled a levee inspection after overnight rain. Editors should verify timing with the public works office.

## Report

City desk confirms river inspection. Officials scheduled a levee inspection after overnight rain. Editors should verify timing with the public works office.`;
		const loopingMarkdown = Array.from({ length: 30 }, () => repeatedBlock).join('\n\n');

		const quality = assessReportQuality(loopingMarkdown);
		const wrapped = wrapMissionReport(job, loopingMarkdown, '2026-05-22T12:00:00.000Z');

		expect(quality.ok).toBe(false);
		expect(quality.reasons).toEqual(expect.arrayContaining(['repeated_sections', 'duplicate_content']));
		expect(wrapped.markdown).toContain('The generated output failed quality checks');
		expect(wrapped.markdown).toContain('## Summary');
		expect(wrapped.markdown).toContain('## Sources');
		expect(wrapped.markdown).toContain('## Uncertainty');
		expect(wrapped.markdown.length).toBeLessThan(1800);
		expect(wrapped.markdown.match(/City desk confirms river inspection/g)?.length ?? 0).toBe(0);
	});

	it('replaces oversized implementation-noisy output with a compact producer-safe fallback', () => {
		const noisyMarkdown = [
			'## Summary',
			'The SDK returned a database payload while the tool budget was exhausted.',
			'## Sources',
			'Raw API response follows.',
			'A very long model trace line. '.repeat(900)
		].join('\n\n');

		const quality = assessReportQuality(noisyMarkdown);
		const wrapped = wrapMissionReport(job, noisyMarkdown, '2026-05-22T12:00:00.000Z');

		expect(quality.ok).toBe(false);
		expect(quality.reasons).toEqual(expect.arrayContaining(['too_long', 'implementation_noise']));
		expect(wrapped.markdown).toContain('The generated output failed quality checks');
		expect(wrapped.markdown).not.toContain('SDK');
		expect(wrapped.markdown).not.toContain('database');
		expect(wrapped.markdown).not.toContain('tool budget');
		expect(wrapped.markdown).not.toContain('too_long');
	});

	it('keeps valid research output exactly as generated', () => {
		const goodMarkdown = `CP News Outlook

(City-River-Inspection)
City officials scheduled a river inspection after overnight rain.
The public works office says the inspection is expected this afternoon.
(7)
---`;

		const wrapped = wrapMissionReport(job, goodMarkdown, '2026-05-22T12:00:00.000Z');

		expect(assessReportQuality(goodMarkdown).ok).toBe(true);
		expect(wrapped.markdown).toContain('City officials scheduled a river inspection');
		expect(wrapped.markdown).toContain('(City-River-Inspection)');
		expect(wrapped.markdown).not.toContain('## Human Review');
		expect(wrapped.markdown).not.toContain('## Lead Candidates');
		expect(wrapped.markdown).not.toContain('failed quality checks');
	});

	it('does not require a recognized format to avoid default section injection', () => {
		const customMarkdown = `ASSIGNMENT DESK QUEUE

1. River inspection follow-up
2. Call public works
3. Hold for editor review`;

		const wrapped = wrapMissionReport(job, customMarkdown, '2026-05-22T12:00:00.000Z');

		expect(wrapped.markdown).toContain('ASSIGNMENT DESK QUEUE');
		expect(wrapped.markdown).not.toContain('## Lead Candidates');
		expect(wrapped.markdown).not.toContain('## Sources');
		expect(wrapped.markdown).not.toContain('## Human Review');
		expect(wrapped.markdown).not.toContain('failed quality checks');
	});
});
