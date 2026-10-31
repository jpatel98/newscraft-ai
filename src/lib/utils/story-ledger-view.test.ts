import { describe, expect, it } from 'vitest';
import type { LedgerStatus } from './story-ledger';
import { ledgerMeter, type StoryLedgerClaimView } from './story-ledger-view';

let next = 0;
const claim = (status: LedgerStatus, needs_check = false): StoryLedgerClaimView => ({
	id: `c${next++}`,
	claim: 'A fact',
	status,
	attributed_to: '',
	citations: [],
	date: '',
	needs_check,
	updated_at: ''
});
const many = (n: number, status: LedgerStatus, needsCheck = false) => Array.from({ length: n }, () => claim(status, needsCheck));

describe('ledgerMeter', () => {
	it('is empty for an empty ledger', () => {
		expect(ledgerMeter([])).toEqual([]);
	});

	it('gives one block per claim when there are five or fewer, safe first and checks last', () => {
		expect(ledgerMeter([claim('reported', true), claim('confirmed'), claim('unverified'), claim('alleged')])).toEqual([
			'safe',
			'careful',
			'hold',
			'check'
		]);
	});

	it('scales a long ledger down to five blocks', () => {
		expect(ledgerMeter([...many(6, 'confirmed'), ...many(4, 'reported')])).toEqual(['safe', 'safe', 'safe', 'careful', 'careful']);
	});

	it('keeps a block for a lone open check in a big ledger', () => {
		const meter = ledgerMeter([...many(40, 'confirmed'), claim('confirmed', true)]);
		expect(meter).toHaveLength(5);
		expect(meter.at(-1)).toBe('check');
	});
});
