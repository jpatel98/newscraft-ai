import { readFileSync } from 'node:fs';

export type NewsroomRole = 'assignment_desk' | 'research' | 'verification' | 'production' | 'monitoring' | 'assistant';

export const NEWSROOM_REPORT_INSTRUCTIONS = readFileSync(
	new URL('../../prompts/newsroom-report.md', import.meta.url),
	'utf8'
).trim();

export const ROLE_INSTRUCTIONS: Record<NewsroomRole, string> = {
	assignment_desk:
		'You are the assignment desk. Identify what the editor is asking for, clarify the story angle, and route work to research, verification, production, or monitoring. Keep humans in control.',
	research:
		'You are the research desk. Gather source-backed context, summarize what is known, keep source provenance, and separate confirmed facts from leads.',
	verification:
		'You are the verification desk. Check claims, look for weak sourcing or conflicts, and flag anything that needs human editorial review before publication.',
	production:
		'You are the production desk. Prepare clear editor-ready drafts, summaries, headlines, and report packaging. Do not publish or make sensitive editorial decisions.',
	monitoring:
		'You are the monitoring desk. Track material changes, summarize what changed, and alert the editor when a human should review.',
	assistant:
		'You are a general NewsCraft newsroom assistant. Help with scanning, summarizing, drafting, verification planning, and alerts. Publishing and sensitive editorial decisions must remain human-approved.'
};

export function chooseRole(prompt: string): NewsroomRole {
	const text = prompt.toLowerCase();
	if (/\b(verify|fact[- ]?check|corroborate|confirm|source check)\b/.test(text)) return 'verification';
	if (/\b(draft|headline|production|package|social|summary)\b/.test(text)) return 'production';
	if (/\b(monitor|watch|alert|track|changes?)\b/.test(text)) return 'monitoring';
	if (/\b(research|background|sources?|read|fetch|rss|url)\b/.test(text)) return 'research';
	if (/\b(assign|angle|pitch|story ideas?|coverage plan)\b/.test(text)) return 'assignment_desk';
	return 'assistant';
}

export function roleLabel(role: NewsroomRole): string {
	return role.replace(/_/g, ' ');
}

export function roleInstructionsFor(role: NewsroomRole): string {
	return `${ROLE_INSTRUCTIONS[role]}

${NEWSROOM_REPORT_INSTRUCTIONS}`;
}
