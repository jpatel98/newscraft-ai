import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { AGENT_BACKEND_IDS, agentBackend } from './backend';

describe('agent backend registry', () => {
	it('defaults to the owned worker', () => {
		expect(agentBackend(undefined).id).toBe('owned');
		expect(agentBackend(' Owned ').id).toBe('owned');
		expect(AGENT_BACKEND_IDS).toContain('owned');
	});

	it('names the valid choices when the configured backend is unknown', () => {
		expect(() => agentBackend('managed')).toThrow(/NEWSCRAFT_AGENT_BACKEND must be one of: owned/);
	});
});
