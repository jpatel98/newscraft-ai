import { describe, expect, it } from 'vitest';
import { attribute, checkCopy, copyRequest, keepsAttribution, lostAttributions, renderCopy, type CopyClaim } from './ledger-copy';

const claim = (id: string, text: string, status: CopyClaim['status'], extra: Partial<CopyClaim> = {}): CopyClaim => ({
	id,
	claim: text,
	status,
	attributed_to: '',
	needs_check: false,
	sources: [],
	...extra
});

const ledger = [
	claim('a', 'Two people were taken to hospital after the Bloor Street crash', 'confirmed'),
	claim('b', 'The driver was going twice the speed limit', 'alleged', { attributed_to: 'Toronto police' }),
	claim('c', 'The eastbound lanes will stay closed until Friday', 'reported', { sources: [{ url: 'https://www.cbc.ca/1', host: 'cbc.ca', tier: 'wire_major' }] }),
	claim('d', 'A second vehicle fled the scene', 'unverified'),
	claim('e', 'A TTC adult fare costs $3.30', 'reported', { needs_check: true }),
	claim('f', 'The driver was drunk', 'retracted')
];

describe('ledger copy', () => {
	it('offers the writer only air-ready claims, with the phrase each must carry', () => {
		const { request, withheld } = copyRequest(ledger);
		expect(request).toEqual([
			{ id: 'c1', claim: ledger[0].claim, say: '' },
			{ id: 'c2', claim: ledger[1].claim, say: 'Toronto police allege' },
			{ id: 'c3', claim: ledger[2].claim, say: 'according to CBC News' }
		]);
		expect(withheld.map((c) => c.id)).toEqual(['d', 'e', 'f']);
	});

	it('accepts any allowed wording and flags a sentence that states an allegation as fact', () => {
		const { byRef } = copyRequest(ledger);
		expect(keepsAttribution('Police allege the driver was going twice the limit.', ledger[1])).toBe(false);
		expect(keepsAttribution('TORONTO POLICE ALLEGE THE DRIVER WAS SPEEDING.', ledger[1])).toBe(true);
		expect(keepsAttribution('The driver is accused of going twice the speed limit.', ledger[1])).toBe(true);
		const lines = [
			{ claims: ['c1'], text: 'Two people are in hospital after a crash on Bloor Street.' },
			{ claims: ['c2'], text: 'The driver was going twice the speed limit.' },
			// Untagged, but it restates the CBC report, so it is held to the same rule.
			{ claims: [], text: 'The eastbound lanes will stay closed until Friday.' }
		];
		expect(lostAttributions(lines, byRef).map((l) => [l.line, l.claimId])).toEqual([[1, 'b'], [2, 'c']]);
	});

	it('puts lost attributions back, drops sentences with no air-ready claim, and leaves nothing lost', () => {
		const { byRef, withheld } = copyRequest(ledger);
		const checked = checkCopy(
			[
				{ claims: ['c2'], text: 'The driver was going twice the speed limit.' },
				{ claims: ['c3'], text: 'The eastbound lanes stay shut until Friday.' },
				{ claims: [], text: 'A second vehicle fled the scene.' },
				{ claims: [], text: 'Stay with us for more.' }
			],
			byRef,
			withheld
		);
		expect(checked.lines.map((l) => l.text)).toEqual([
			'Toronto police allege that the driver was going twice the speed limit.',
			'According to CBC News, the eastbound lanes stay shut until Friday.'
		]);
		expect(checked).toMatchObject({ repaired: 2, dropped: 2 });
		expect(lostAttributions(checked.lines, byRef)).toEqual([]);
	});

	it('keeps proper nouns capitalized when it adds a phrase', () => {
		expect(attribute('Gholami faces 12 charges.', claim('x', 'Gholami faces 12 charges', 'alleged', { attributed_to: 'CBSA' }))).toBe(
			'CBSA alleges that Gholami faces 12 charges.'
		);
	});

	it('renders paste-ready uppercase copy', () => {
		const lines = [{ claims: ['c1'], text: 'Two people are hurt.' }, { claims: ['c2'], text: 'Police allege speeding.' }];
		expect(renderCopy('vo', lines)).toBe('{VO}\nTWO PEOPLE ARE HURT. POLICE ALLEGE SPEEDING.');
		expect(renderCopy('reader', lines)).toBe('TWO PEOPLE ARE HURT. POLICE ALLEGE SPEEDING.');
	});
});
