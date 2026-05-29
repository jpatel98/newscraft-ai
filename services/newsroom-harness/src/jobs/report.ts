import type { NewsroomJobDto } from '@newscraft/shared';
import type { BeatMonitorRunResult } from '../agents/beat-monitor.js';
import { filenameTimestamp } from '../util/ids.js';
import { assessReportQuality, fallbackProducerReport } from '../util/report-quality.js';

export function wrapMissionReport(job: NewsroomJobDto, markdown: string, runTime: string): { filename: string; markdown: string } {
	const filename = `${filenameTimestamp(new Date(runTime))}.md`;
	const quality = assessReportQuality(markdown);
	const report = quality.ok ? markdown.trim() : fallbackProducerReport();
	return {
		filename,
		markdown: `# Cron Job: ${job.name}

**Job ID:** ${job.id}
**Run Time:** ${runTime}
**Schedule:** ${job.schedule}

## Response

${report}
`
	};
}

export async function postReportToUi(input: {
	url: string;
	key: string;
	id: string;
	job: NewsroomJobDto;
	runTime: string;
	filename: string;
	markdown: string;
	signal?: AbortSignal;
}): Promise<void> {
	if (!input.url || !input.key) return;
	const response = await fetch(input.url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${input.key}`
		},
		body: JSON.stringify({
			id: input.id,
			jobId: input.job.id,
			channel: input.job.name,
			runTime: input.runTime,
			schedule: input.job.schedule,
			filename: input.filename,
			filePathDisplay: `${input.job.id}/${input.filename}`,
			markdown: input.markdown
		}),
		signal: input.signal
	});
	if (!response.ok) throw new Error(`UI ingest ${response.status}: ${await response.text()}`);
}

export function beatMonitorReportMarkdown(job: NewsroomJobDto, result: BeatMonitorRunResult): string {
	const pitchLines = result.gates.map((gate, index) => {
		const payload = objectValue(gate.payload);
		const title = stringValue(payload?.title) || `Pitch gate ${index + 1}`;
		const whyNow = stringValue(payload?.why_now);
		const suggestedAngle = stringValue(payload?.suggested_angle);
		const sources = arrayValue(payload?.source_set)
			.map((source) => objectValue(source))
			.map((source) => sourceLink(stringValue(source?.title), stringValue(source?.url)))
			.filter(Boolean);
		const sourceText = sources.length ? ` Sources: ${sources.join('; ')}.` : '';
		const detail = [whyNow, suggestedAngle].filter(Boolean).join(' ');
		return `- ${title}${detail ? ` — ${detail}` : ''}${sourceText}`;
	});
	const gateLines = result.gates.map((gate) => `- ${gate.id}: ${stringValue(objectValue(gate.payload)?.title) || gate.type}`);
	const summary =
		result.pitchCount > 0
			? `${job.name} scanned ${result.sourceCount} source${result.sourceCount === 1 ? '' : 's'} and queued ${result.pitchCount} pitch gate${result.pitchCount === 1 ? '' : 's'} for editor review.`
			: `${job.name} scanned ${result.sourceCount} source${result.sourceCount === 1 ? '' : 's'} and found no new pitch gates for editor review.`;

	return [
		'## Summary',
		'',
		summary,
		'',
		'## Lead Candidates',
		'',
		pitchLines.length ? pitchLines.join('\n') : '- No new lead candidates were queued on this run.',
		'',
		'## Source Notes',
		'',
		`- Sources scanned: ${result.sourceCount}`,
		`- Pitch gates queued: ${result.pitchCount}`,
		...(gateLines.length ? ['- Gate IDs:', ...gateLines] : []),
		'',
		'## Human Review',
		'',
		result.pitchCount > 0
			? 'Review the queued pitch gates before moving any lead into a story workspace.'
			: 'No editor action is required unless the source setup should be changed.'
	].join('\n');
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function sourceLink(title: string, url: string): string {
	if (!url) return title;
	return title ? `${title} (${url})` : url;
}
