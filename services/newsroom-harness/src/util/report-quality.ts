export interface ReportQualityResult {
	ok: boolean;
	reasons: string[];
}

const MAX_REPORT_CHARS = 16_000;
const MAX_DUPLICATE_LINE_OCCURRENCES = 5;
const MAX_DUPLICATE_LINE_RATIO = 0.3;
const MAX_DUPLICATE_PARAGRAPH_OCCURRENCES = 3;
const MAX_DUPLICATE_WORD_WINDOW_OCCURRENCES = 6;

const IMPLEMENTATION_NOISE_PATTERNS = [
	/\b(?:SDK|API|database|harness|stack trace|tool budget|token budget|maxTurns|runTimeoutMs)\b/i,
	/\b(?:function call|tool call|raw_model_stream_event|output_text_delta)\b/i,
	/\b(?:stdout|stderr|JSON payload|schema validation|environment variable)\b/i
];

export function assessReportQuality(markdown: string): ReportQualityResult {
	const reasons: string[] = [];
	const trimmed = markdown.trim();

	if (!trimmed) {
		reasons.push('empty');
		return { ok: false, reasons };
	}

	if (trimmed.length > MAX_REPORT_CHARS) {
		reasons.push('too_long');
	}

	if (hasRepeatedSections(trimmed)) {
		reasons.push('repeated_sections');
	}

	if (hasExcessiveDuplicateLines(trimmed)) {
		reasons.push('duplicate_lines');
	}

	if (hasExcessiveDuplicateParagraphs(trimmed)) {
		reasons.push('duplicate_content');
	}

	if (hasRepeatedWordWindows(trimmed)) {
		reasons.push('looping_content');
	}

	if (hasImplementationNoise(trimmed)) {
		reasons.push('implementation_noise');
	}

	return { ok: reasons.length === 0, reasons };
}

export function fallbackProducerReport(): string {
	return `## Summary

The generated output failed quality checks and was not saved as an editor-ready draft. Rerun the mission or have a producer review the source material before using this report.

## Lead Candidates

No lead candidates are ready for assignment from this run.

## Source Notes

Review the mission sources directly before making coverage decisions.

## Verification Notes

Confirm any possible story angle against primary sources before use.

## Human Review

A human editor should rerun or review this mission before any assignment or publication decision.`;
}

function hasRepeatedSections(markdown: string): boolean {
	const headings = markdown
		.split(/\r?\n/)
		.map((line) => line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1])
		.filter((heading): heading is string => Boolean(heading))
		.map(normalizeText)
		.filter(Boolean);
	const counts = countOccurrences(headings);
	return [...counts.values()].some((count) => count >= 3);
}

function hasExcessiveDuplicateLines(markdown: string): boolean {
	const lines = markdown
		.split(/\r?\n/)
		.map(normalizeText)
		.filter((line) => line.length >= 24);
	if (lines.length < 8) return false;

	const counts = countOccurrences(lines);
	const maxOccurrences = Math.max(...counts.values());
	const duplicateCount = [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
	return maxOccurrences >= MAX_DUPLICATE_LINE_OCCURRENCES || duplicateCount / lines.length > MAX_DUPLICATE_LINE_RATIO;
}

function hasExcessiveDuplicateParagraphs(markdown: string): boolean {
	const paragraphs = markdown
		.split(/\n{2,}/)
		.map(normalizeText)
		.filter((paragraph) => paragraph.length >= 80);
	if (paragraphs.length < 4) return false;

	const counts = countOccurrences(paragraphs);
	return [...counts.values()].some((count) => count >= MAX_DUPLICATE_PARAGRAPH_OCCURRENCES);
}

function hasRepeatedWordWindows(markdown: string): boolean {
	const words = normalizeText(markdown).split(' ').filter(Boolean);
	if (words.length < 120) return false;

	const windows: string[] = [];
	for (let index = 0; index <= words.length - 16; index += 4) {
		windows.push(words.slice(index, index + 16).join(' '));
	}
	const counts = countOccurrences(windows);
	return [...counts.values()].some((count) => count >= MAX_DUPLICATE_WORD_WINDOW_OCCURRENCES);
}

function hasImplementationNoise(markdown: string): boolean {
	return IMPLEMENTATION_NOISE_PATTERNS.some((pattern) => pattern.test(markdown));
}

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.replace(/\[[^\]]+\]\([^)]+\)/g, '')
		.replace(/https?:\/\/\S+/g, '')
		.replace(/[`*_>#-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function countOccurrences(values: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) {
		counts.set(value, (counts.get(value) || 0) + 1);
	}
	return counts;
}
