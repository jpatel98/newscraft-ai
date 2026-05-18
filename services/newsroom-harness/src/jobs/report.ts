import type { NewsroomJobDto } from '@newscraft/shared';
import { filenameTimestamp } from '../util/ids.js';

const REQUIRED_EDITOR_SECTIONS = [
	{
		title: 'Summary',
		fallback: 'No structured summary was produced. Review the source notes and run log before using this draft.'
	},
	{
		title: 'Source Notes',
		fallback: 'No structured source notes were produced. Review stored source snapshots before using this draft.'
	},
	{
		title: 'Verification Notes',
		fallback: 'Confirm factual claims against primary sources and resolve unclear sourcing before use.'
	},
	{
		title: 'Human Review',
		fallback: 'A human editor must approve story angle, sourcing, legal/privacy sensitivity, and publication decisions.'
	}
] as const;

export function ensureProducerReportSections(markdown: string): string {
	let report = markdown.trim();
	for (const section of REQUIRED_EDITOR_SECTIONS) {
		const heading = new RegExp(`^#{2,3}\\s+${escapeRegExp(section.title)}\\s*$`, 'im');
		if (!heading.test(report)) {
			report += `\n\n## ${section.title}\n\n${section.fallback}`;
		}
	}
	return report;
}

export function wrapMissionReport(job: NewsroomJobDto, markdown: string, runTime: string): { filename: string; markdown: string } {
	const filename = `${filenameTimestamp(new Date(runTime))}.md`;
	const report = ensureProducerReportSections(markdown);
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
