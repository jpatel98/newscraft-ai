import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('newsroom overview gates', () => {
	it('loads the persisted gate queue and event feed from the agent gateway', () => {
		const source = readFileSync(new URL('./+page.server.ts', import.meta.url), 'utf8');

		expect(source).toContain("import { ensureDemoGate, listEditorialEvents } from '$lib/server/agent/gates'");
		expect(source).toContain('gates = await ensureDemoGate(locals.user.id)');
		expect(source).toContain('gateEvents = await listEditorialEvents(locals.user.id)');
		expect(source).toContain('gateError');
	});

	it('renders open gate cards and pushes resolved gate events into the wire', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain("import OpenGateCard from '$lib/components/OpenGateCard.svelte'");
		expect(source).toContain('const openGates = $derived(editorialGates.filter((gate) => gate.status ===');
		expect(source).toContain('/api/gates/${encodeURIComponent(gate.id)}/resolve');
		expect(source).toContain('<OpenGateCard');
		expect(source).toContain('wireFromEditorialEvent');
		expect(source).toContain("'gate.resolved'");
	});

	it('renders draft citation markers as source-backed controls with archive fallback', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain("import { segmentDraftWithCitations, type CitationRecord } from '$lib/utils/citations'");
		expect(source).toContain('selectedDraftSegments');
		expect(source).toContain('Open source details for citation');
		expect(source).toContain('selectedCitation.sourceUrl');
		expect(source).toContain('selectedCitation.archiveUrl');
		expect(source).toContain('Archive fallback');
	});

	it('routes overview command bar sends through the editor command endpoint', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain('async function handleCommandSend(content: MessageContent)');
		expect(source).toContain("fetch('/api/agent/editor-command'");
		expect(source).toContain('targetAgent: commandTarget(command)');
		expect(source).toContain('facts: commandFacts(selectedWorkspace)');
		expect(source).toContain("if (selectedWorkspace && /\\b(draft|write|lede|headline)\\b/i.test(command)) return 'drafting'");
		expect(source).toContain("return 'research'");
		expect(source).toContain("if (/\\b(lead|leads|source|monitor|beat)\\b/i.test(command)) return 'monitor'");
		expect(source).toContain('onSend={handleCommandSend}');
		expect(source).toContain('commandResult.handled_by');
		expect(source).toContain('Monitor');
		expect(source).toContain('Research');
		expect(source).toContain('Drafting');
	});
});
