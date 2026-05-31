import type { NewsroomJobDto } from '@newscraft/shared';
import { filenameTimestamp } from '../util/ids.js';
import { assessReportQuality, fallbackProducerReport } from '../util/report-quality.js';

export function wrapMissionReport(job: NewsroomJobDto, markdown: string, runTime: string): { filename: string; markdown: string } {
	const filename = `${filenameTimestamp(new Date(runTime))}.md`;
	const quality = assessReportQuality(markdown);
	const report = quality.ok ? markdown.trim() : fallbackProducerReport();
	return {
		filename,
		markdown: `# Research Update: ${job.name}

**Story ID:** ${job.id}
**Research Time:** ${runTime}
**Schedule:** ${job.schedule}

## Update

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
