import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mission report expanded metadata', () => {
	it('keeps raw report markdown out of the default mission view', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).not.toContain('Mission {post.jobId}');
		expect(source).not.toContain('Backed by {post.filePathDisplay}');
		expect(source).not.toContain('ensureReportBody');
		expect(source).toContain('Run progress');
		expect(source).toContain('Latest saved output');
	});

	it('lets producers expand the full saved output from the preview card', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain('View full output');
		expect(source).toContain('handleLatestOutputToggle');
		expect(source).toContain('/api/agent/reports/${encodeURIComponent(post.id)}');
		expect(source).toContain('{#each selectedPosts as post, index (post.id)}');
		expect(source).toContain('<Markdown content={savedOutputMarkdown(post)} />');
		expect(source).toContain('class="latest-output__markdown"');
		expect(source).toContain('class="latest-output__details"');
	});

	it('shows all saved outputs for a mission instead of only the latest one', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain('Saved outputs');
		expect(source).toContain('Mission reports');
		expect(source).toContain('{selectedPosts.length}');
		expect(source).toContain('{#each selectedPosts as post, index (post.id)}');
		expect(source).not.toContain('const latestOutputMarkdown');
	});

	it('does not treat run progress placeholders as saved outputs', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain("post.channelSlug === selectedChannel.slug && post.kind !== 'run'");
	});

	it('exposes mission CRUD through the selected mission controls', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain('function openEdit()');
		expect(source).toContain('onclick={openEdit}');
		expect(source).toContain('Edit mission');
		expect(source).toContain('function deleteSelectedMission()');
		expect(source).toContain('onclick={deleteSelectedMission}');
		expect(source).toContain("method: 'DELETE'");
		expect(source).toContain("url.searchParams.set('edit', '1')");
		expect(source).toContain('untrack(() => applyQueryState(params, true));');
		expect(source).toContain('if (!createOpen && !renameOpen) replaceChannelUrl();');
		expect(source).toContain("method: 'PATCH'");
		expect(source).toContain("{createBusy ? 'Saving' : 'Save changes'}");
	});

	it('does not expose fixed delivery or output format controls', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).not.toContain('Delivery target');
		expect(source).not.toContain('channel-deliver');
		expect(source).not.toContain('Output format');
		expect(source).not.toContain('mission-output-format');
	});

	it('keeps Run now available as a manual action independent of the schedule state', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const runNowIndex = source.indexOf("onclick={() => jobAction('run')}");
		const scheduleToggleIndex = source.indexOf('{#if selectedJob.enabled}');

		expect(runNowIndex).toBeGreaterThan(0);
		expect(scheduleToggleIndex).toBeGreaterThan(0);
		expect(runNowIndex).toBeLessThan(scheduleToggleIndex);
		expect(source).toContain(
			"{selectedJobRunning ? 'Running' : actionBusy === 'run' || selectedRunRequested ? 'Starting' : 'Run now'}"
		);
		expect(source).toContain('disabled={Boolean(actionBusy) || selectedJobRunning || selectedRunRequested}');
	});

	it('does not let stale active run rows lock the Run now action forever', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain('const ACTIVE_RUN_STALE_MS = 10 * 60_000');
		expect(source).toContain('function isStaleActiveRun(run: AgentRun): boolean');
		expect(source).toContain('return !isStaleActiveRun(run);');
	});

	it('keeps completed manual runs from adding redundant success noise', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).not.toContain('output-saved');
		expect(source).not.toContain('Run completed and output was saved.');
		expect(source).not.toContain('Mission run completed.');
		expect(source).toContain('Run progress');
		expect(source).toContain('Latest saved output');
	});

	it('uses the latest run activity for mission status freshness', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain('function missionActivityAt(');
		expect(source).toContain('missionActivityAt(selectedChannel, selectedJob, selectedProgressRun)');
	});
});
