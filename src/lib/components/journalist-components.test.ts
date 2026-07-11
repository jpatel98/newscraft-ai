import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(name: string): string {
	return readFileSync(new URL(name, import.meta.url), 'utf8');
}

describe('journalist trust components', () => {
	it('renders resolved numeric markers as labelled native buttons', () => {
		const markdown = source('./Markdown.svelte');
		expect(markdown).toContain("button.className = 'md-citation';");
		expect(markdown).toContain("button.setAttribute('aria-label', `Citation ${number}: ${records[0].title}`)");
		expect(markdown).toContain("parent.closest('a, button, code, pre, script, style, textarea')");
		expect(markdown).toContain("records.length !== 1");
		expect(markdown).toContain('!isInspectableCitationRecord(records[0])');
	});

	it('provides a modal evidence preview with focus restoration and mobile bottom-sheet layout', () => {
		const preview = source('./EvidencePreview.svelte');
		expect(preview).toContain('role="dialog"');
		expect(preview).toContain('aria-modal="true"');
		expect(preview).toContain("event.key === 'Escape'");
		expect(preview).toContain('target?.focus()');
		expect(preview).toContain('@media (max-width: 640px)');
		expect(preview).toContain('place-items: end stretch');
		expect(preview).toContain("citation.supportingExcerpt || 'No supporting excerpt is available.'");
	});

	it('keeps the legacy source list unless every visible citation resolves', () => {
		const thread = source('./Thread.svelte');
		const disclosure = source('./SourceDisclosure.svelte');
		expect(thread).toContain('parseToolMetadata(message.toolCalls).citations');
		expect(thread).toContain('activeAssistant ? chat.citations : []');
		expect(thread).toContain('resolvedInline={citationState.allResolved}');
		expect(disclosure).toContain('{#if sources.length > 0 && !resolvedInline}');
	});

	it('dispatches each Use answer choice through the visible-turn integration callback', () => {
		const actions = source('./AnswerActions.svelte');
		expect(actions).toContain('Promise.resolve(onSelect(action))');
		expect(actions).toContain('role="menu"');
		expect(actions).toContain('role="menuitem"');
	});

	it('exposes per-answer Markdown export without changing transcript export', () => {
		const thread = source('./Thread.svelte');
		expect(thread).toContain('answerExportUrl(conversationId, m.id)');
		expect(thread).toContain('onExportAnswer?.(m.id, exportUrl)');
		expect(thread).toContain('aria-label="Export answer as Markdown"');
	});
});
