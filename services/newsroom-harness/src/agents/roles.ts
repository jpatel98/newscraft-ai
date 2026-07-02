import { readFileSync } from 'node:fs';

export type NewsroomRole = 'assignment_desk' | 'research' | 'monitoring' | 'assistant';

export const NEWSROOM_REPORT_INSTRUCTIONS = readPrompt('newsroom-report.md');

function readPrompt(name: string): string {
	const candidates = [
		new URL(`../../prompts/${name}`, import.meta.url),
		new URL(`../prompts/${name}`, import.meta.url)
	];
	for (const url of candidates) {
		try {
			return readFileSync(url, 'utf8').trim();
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
	}
	throw new Error(`Missing newsroom prompt: ${name}`);
}

export const ROLE_INSTRUCTIONS: Record<NewsroomRole, string> = {
	assignment_desk:
		'You are the assignment desk. Identify what the producer is asking for, clarify the story angle, and route work to research or source monitoring.',
	research:
		'You are the research desk. Gather source-backed context, summarize what is known, keep source provenance, and separate confirmed facts from leads.',
	monitoring:
		'You are the source monitor. Track material changes, summarize what changed, and flag uncertainty plainly.',
	assistant:
		'You are a general NewsCraft newsroom assistant for a solo news producer. Help with scanning, summarizing, comparing coverage, and finding recent source-backed information.'
};

export function roleLabel(role: NewsroomRole): string {
	return role.replace(/_/g, ' ');
}

export function roleInstructionsFor(role: NewsroomRole): string {
	return `${ROLE_INSTRUCTIONS[role]}

${NEWSROOM_REPORT_INSTRUCTIONS}`;
}
