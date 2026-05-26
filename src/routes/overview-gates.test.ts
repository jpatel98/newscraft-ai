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
});
