import { describe, expect, it } from 'vitest';
import {
	LEDGER_MAX_CLAIMS,
	splitLedgerBlock,
	stripLedgerForDisplay
} from './story-ledger';

const claim = (overrides: Record<string, unknown> = {}) => ({
	claim: 'Three soldiers were hurt in the crash.',
	status: 'confirmed',
	attributed_to: 'Department of National Defence',
	citations: [3, 5],
	date: '2026-07-02',
	needs_check: false,
	...overrides
});

const fence = (body: string, close = true) => `\`\`\`newscraft-ledger\n${body}${close ? '\n```' : ''}`;

describe('splitLedgerBlock', () => {
	it('extracts a valid trailing block and removes it from the visible answer', () => {
		const answer = `The crash injured three soldiers [3].\n\n${fence(JSON.stringify({ claims: [claim()] }))}\n`;
		const result = splitLedgerBlock(answer);
		expect(result.visible).toBe('The crash injured three soldiers [3].');
		expect(result.found).toBe(true);
		expect(result.claims).toEqual([
			{
				claim: 'Three soldiers were hurt in the crash.',
				status: 'confirmed',
				attributedTo: 'Department of National Defence',
				citations: [3, 5],
				date: '2026-07-02',
				needsCheck: false
			}
		]);
	});

	it('returns the text untouched when there is no block', () => {
		expect(splitLedgerBlock('Plain answer.\n\n```js\nconsole.log(1)\n```')).toEqual({
			visible: 'Plain answer.\n\n```js\nconsole.log(1)\n```',
			claims: null,
			found: false
		});
	});

	it('strips a block with invalid JSON and reports null claims', () => {
		const result = splitLedgerBlock(`Answer.\n\n${fence('{"claims": [oops')}`);
		expect(result).toEqual({ visible: 'Answer.', claims: null, found: true });
	});

	it('tolerates a missing closing fence and surrounding whitespace', () => {
		const body = JSON.stringify({ claims: [claim({ status: 'alleged' })] });
		const result = splitLedgerBlock(`Answer.\n\n   \n${fence(`  ${body}  `, false)}   \n\n`);
		expect(result.visible).toBe('Answer.');
		expect(result.claims?.[0]?.status).toBe('alleged');
	});

	it('keeps an earlier unrelated code fence and only removes the trailing ledger', () => {
		const result = splitLedgerBlock(
			`Code:\n\`\`\`json\n{"a":1}\n\`\`\`\nDone.\n\n${fence(JSON.stringify({ claims: [claim()] }))}`
		);
		expect(result.visible).toBe('Code:\n```json\n{"a":1}\n```\nDone.');
		expect(result.claims).toHaveLength(1);
	});

	it('does not treat a ledger fence that is followed by more prose as the trailing block', () => {
		const text = `${fence(JSON.stringify({ claims: [claim()] }))}\nMore prose after the block.`;
		expect(splitLedgerBlock(text)).toEqual({ visible: text, claims: null, found: false });
	});

	it('caps the ledger at 12 claims', () => {
		const claims = Array.from({ length: 20 }, (_, index) => claim({ claim: `Claim number ${index}` }));
		const result = splitLedgerBlock(`A\n\n${fence(JSON.stringify({ claims }))}`);
		expect(result.claims).toHaveLength(LEDGER_MAX_CLAIMS);
		expect(result.claims?.[11]?.claim).toBe('Claim number 11');
	});

	it('drops claims with an invalid status or an over-long claim', () => {
		const claims = [
			claim({ claim: 'ok one' }),
			claim({ claim: 'bad status', status: 'rumour' }),
			claim({ claim: 'x'.repeat(241) }),
			claim({ claim: '   ' }),
			'not an object',
			claim({ claim: 'x'.repeat(240), status: 'Retracted' })
		];
		const result = splitLedgerBlock(`A\n\n${fence(JSON.stringify({ claims }))}`);
		expect(result.claims?.map((item) => item.claim)).toEqual(['ok one', 'x'.repeat(240)]);
		expect(result.claims?.[1]?.status).toBe('retracted');
	});

	it('validates citations and dates field by field', () => {
		const claims = [
			claim({ citations: [1, 0, -2, 2.5, '3', 4, 4, null], date: '2026-02-30' }),
			claim({ claim: 'second', citations: 'nope', date: '07/02/2026' }),
			claim({ claim: 'third', date: '', needs_check: true, supersedes: 'abc123' })
		];
		const result = splitLedgerBlock(`A\n\n${fence(JSON.stringify({ claims }))}`);
		expect(result.claims?.[0]).toMatchObject({ citations: [1, 4], date: '' });
		expect(result.claims?.[1]).toMatchObject({ citations: [], date: '' });
		expect(result.claims?.[2]).toMatchObject({ date: '', needsCheck: true, supersedes: 'abc123' });
	});

	it('treats a payload without a claims array as invalid', () => {
		expect(splitLedgerBlock(`A\n\n${fence('{"facts": []}')}`)).toMatchObject({ claims: null, found: true });
	});
});

describe('stripLedgerForDisplay', () => {
	it('hides complete, unterminated and partially streamed fences', () => {
		const body = JSON.stringify({ claims: [claim()] });
		expect(stripLedgerForDisplay(`Hello.\n\n${fence(body)}`)).toBe('Hello.');
		expect(stripLedgerForDisplay(`Hello.\n\n${fence(body.slice(0, 30), false)}`)).toBe('Hello.');
		expect(stripLedgerForDisplay('Hello.\n\n```newscraft-le')).toBe('Hello.');
		expect(stripLedgerForDisplay('Hello.\n\n```newsc')).toBe('Hello.');
	});

	it('leaves ordinary text and ordinary code fences alone', () => {
		expect(stripLedgerForDisplay('Hello.')).toBe('Hello.');
		expect(stripLedgerForDisplay('Hello.\n\n```')).toBe('Hello.\n\n```');
		expect(stripLedgerForDisplay('Hello.\n\n```js\nlet a;\n```')).toBe('Hello.\n\n```js\nlet a;\n```');
		expect(stripLedgerForDisplay('')).toBe('');
	});
});
