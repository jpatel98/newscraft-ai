import { describe, expect, it } from 'vitest';
import { HARNESS_POSTGRES_TABLES } from '../src/db/supabase-mirror.js';

describe('harness postgres mirror table spec', () => {
	it('includes usage_ledger in the mirrored table contract', () => {
		const usageLedger = HARNESS_POSTGRES_TABLES.find((table) => table.name === 'usage_ledger');
		expect(usageLedger).toBeDefined();
		expect(usageLedger?.appendOnly).toBe(true);
		expect(usageLedger?.columns).toContain('usage_metadata_json');
		expect(usageLedger?.columns).toContain('cost_metadata_json');
		expect(usageLedger?.columns).toContain('provider');
		expect(usageLedger?.columns).toContain('model');
		expect(usageLedger?.columns).toContain('latency_ms');
	});
});
