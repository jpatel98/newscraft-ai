import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeEvidence, type EvidenceObject } from '../src/agents/evidence.js';
import { enforceFinalCitationIntegrity } from '../src/agents/answer.js';
import {
	completeGroundedEvidenceStatement,
	groundedAnswerFromClaims,
	groundedClaimFromEvidence,
	normalizeGroundedEvidence,
	renderGroundedAnswer,
	validateGroundedClaim,
	type GroundedClaim
} from '../src/agents/grounded-answer.js';

function source(id: string, text: string, overrides: Partial<EvidenceObject> = {}): EvidenceObject {
	return normalizeEvidence({
		evidence_id: id,
		canonical_url: `https://example.test/${id}`,
		source_url: `https://example.test/${id}`,
		source_name: `Source ${id}`,
		title: `Source ${id}`,
		accessed_at: '2026-08-08T12:00:00.000Z',
		tool_used: 'test',
		extracted_text: text,
		summary: text,
		supporting_excerpt: text,
		confidence: 0.9,
		limitations: [],
		source_kind: 'news_report',
		ledger_status: 'accepted',
		...overrides
	});
}

function claim(
	claimId: string,
	visibleText: string,
	evidenceIds: readonly string[],
	partial: Partial<GroundedClaim['presentation']> = {}
): GroundedClaim {
	return {
		claimId,
		visibleText,
		evidenceIds,
		presentation: { kind: 'paragraph', ...partial }
	};
}

describe('structured grounded answer ledger', () => {
	it('normalizes evidence occurrence order and ignores duplicate provider-local numbers', () => {
		const evidence = [
			source('first', 'Alpha event happened today.', { citation_number: 1 }),
			source('second', 'Beta event happened yesterday.', { citation_number: 1 })
		];
		const ledger = normalizeGroundedEvidence(evidence);

		expect([...ledger.citationById.values()]).toEqual([1, 2]);
		expect(evidence.map((item) => item.citation_number)).toEqual([1, 2]);
		expect(
			renderGroundedAnswer(
				groundedAnswerFromClaims([
					claim('a', 'Alpha event happened today.', ['first']),
					claim('b', 'Beta event happened yesterday.', ['second'])
				]),
				ledger
			)
		).toBe('Alpha event happened today. [1]\nBeta event happened yesterday. [2]');
	});

	it('keeps multi-source claims grouped and drops unsupported markers conservatively', () => {
		const evidence = [
			source('alpha', 'Alpha event happened today.'),
			source('corroboration', 'Alpha event happened today, according to a second report.'),
			source('unrelated', 'Beta event happened yesterday.')
		];
		const ledger = normalizeGroundedEvidence(evidence);
		const grouped = claim('grouped', 'Alpha event happened today.', ['alpha', 'corroboration']);
		const partiallySupported = claim('partial', 'Alpha event happened today.', ['alpha', 'unrelated']);

		expect(validateGroundedClaim(grouped, ledger)).toBe(true);
		expect(validateGroundedClaim(partiallySupported, ledger)).toBe(false);
		expect(
			renderGroundedAnswer(groundedAnswerFromClaims([partiallySupported]), ledger)
		).toBe('Alpha event happened today. [1]');
		expect(
			renderGroundedAnswer(groundedAnswerFromClaims([grouped]), ledger)
		).toBe('Alpha event happened today. [1] [2]');
	});

	it('rejects malformed and clipped structured claims, then falls back to the complete evidence statement', () => {
		const evidence = [
			source(
				'salsa',
				'Toronto’s Salsa on St. Clair is hosting a community dance program this weekend.',
				{ extracted_text: 'Toronto’s Salsa on St.', summary: 'Toronto’s Salsa on St. Clair is hosting a community dance program this weekend.' }
			)
		];
		const ledger = normalizeGroundedEvidence(evidence);
		const clipped = claim('clipped', 'Toronto’s Salsa on', ['salsa'], { kind: 'bullet' });
		const malformed = claim('malformed', 'Toronto’s Salsa on [1', ['salsa']);

		expect(validateGroundedClaim(clipped, ledger)).toBe(false);
		expect(validateGroundedClaim(malformed, ledger)).toBe(false);
		expect(renderGroundedAnswer(groundedAnswerFromClaims([clipped]), ledger)).toBe(
			'- Toronto’s Salsa on St. Clair is hosting a community dance program this weekend. [1]'
		);
		expect(renderGroundedAnswer(groundedAnswerFromClaims([malformed]), ledger)).toBe(
			'Toronto’s Salsa on St. Clair is hosting a community dance program this weekend. [1]'
		);
	});

	it('rejects terminal title fragments while accepting a genuinely complete terminal abbreviation', () => {
		const evidence = [
			source('clipped-title', 'Toronto’s Salsa on St. Clair is hosting a community dance program this weekend.'),
			source('complete-abbreviation', 'The abbreviation is St.')
		];
		const ledger = normalizeGroundedEvidence(evidence);

		expect(
			groundedClaimFromEvidence(evidence[0], ledger, { visibleText: 'Toronto’s Salsa on St.' })
		).toBeNull();
		expect(
			groundedClaimFromEvidence(evidence[1], ledger, { visibleText: 'The abbreviation is St.' })
		).not.toBeNull();
	});

	it('fails closed for ambiguous terminal abbreviations without an explicit definition', () => {
		const evidence = [
			source('at-st', 'The event is at St.'),
			source('venue-st', 'The venue is Toronto’s Salsa on St.'),
			source('defined-st', 'The abbreviation is St.')
		];
		const ledger = normalizeGroundedEvidence(evidence);

		expect(completeGroundedEvidenceStatement(evidence[0])).toBe('');
		expect(completeGroundedEvidenceStatement(evidence[1])).toBe('');
		expect(groundedClaimFromEvidence(evidence[0], ledger)).toBeNull();
		expect(groundedClaimFromEvidence(evidence[1], ledger)).toBeNull();
		expect(groundedClaimFromEvidence(evidence[2], ledger)).not.toBeNull();
	});

	it('keeps version identifiers atomic at support boundaries', () => {
		const evidence = [
			source('exact-version', 'Version 1.2.3.'),
			source('beta-version', 'Version 1.2.3-beta')
		];
		const ledger = normalizeGroundedEvidence(evidence);

		expect(groundedClaimFromEvidence(evidence[0], ledger, { visibleText: 'Version 1.2.3.' })).not.toBeNull();
		expect(groundedClaimFromEvidence(evidence[1], ledger, { visibleText: 'Version 1.2.3' })).toBeNull();
		expect(groundedClaimFromEvidence(evidence[1], ledger, { visibleText: 'Version 1.2.3-beta' })).not.toBeNull();
	});

	it('treats SemVer prerelease and build metadata as one support unit', () => {
		const evidence = [
			source('exact-build', 'Version 1.2.3 is installed.'),
			source('beta-build', 'Version 1.2.3-beta is installed.'),
			source('metadata-build', 'Version 1.2.3+build.4 is installed.'),
			source('url-version', 'Release details are at https://example.test/v1.2.3-beta.')
		];
		const ledger = normalizeGroundedEvidence(evidence);

		expect(groundedClaimFromEvidence(evidence[0], ledger, { visibleText: 'Version 1.2.3.' })).not.toBeNull();
		expect(groundedClaimFromEvidence(evidence[1], ledger, { visibleText: 'Version 1.2.3.' })).toBeNull();
		expect(groundedClaimFromEvidence(evidence[2], ledger, { visibleText: 'Version 1.2.3.' })).toBeNull();
		expect(
			groundedClaimFromEvidence(evidence[2], ledger, { visibleText: 'Version 1.2.3+build.4 is installed.' })
		).not.toBeNull();
		expect(
			groundedClaimFromEvidence(evidence[3], ledger, {
				visibleText: 'Release details are at https://example.test/v1.2.3-beta.'
			})
		).not.toBeNull();
		expect(
			groundedClaimFromEvidence(evidence[3], ledger, {
				visibleText: 'Release details are at https://example.test/v1.2.3.'
			})
		).toBeNull();
	});

	it('fails closed when every retained field is clipped, but uses one complete field when available', () => {
		const clipped = source('all-clipped', 'Toronto’s Salsa on', {
			extracted_text: 'Toronto’s Salsa on',
			summary: 'Toronto’s Salsa on',
			supporting_excerpt: 'Toronto’s Salsa on'
		});
		const recovered = source('one-complete', 'Toronto’s Salsa on', {
			extracted_text: 'Toronto’s Salsa on',
			summary: 'Toronto’s Salsa on St. Clair is hosting a community dance program this weekend.',
			supporting_excerpt: 'Toronto’s Salsa on'
		});
		const ledger = normalizeGroundedEvidence([clipped, recovered]);

		expect(completeGroundedEvidenceStatement(clipped)).toBe('');
		expect(groundedClaimFromEvidence(clipped, ledger)).toBeNull();
		expect(completeGroundedEvidenceStatement(recovered)).toContain('St. Clair');
		expect(groundedClaimFromEvidence(recovered, ledger)).not.toBeNull();
	});

	it('preserves initials, URLs, versions, and the first complete source sentence', () => {
		const cases = [
			[
				'A. B. Smith was quoted by the report. U.S. officials responded.',
				'A. B. Smith was quoted by the report.'
			],
			[
				'See https://example.test/releases/v1.2.3. The service remains open.',
				'See https://example.test/releases/v1.2.3.'
			],
			['Version 1.2.3. The service remains open.', 'Version 1.2.3.']
		] as const;

		for (const [text, expected] of cases) {
			expect(completeGroundedEvidenceStatement(source('statement', text))).toBe(expected);
		}
	});

	it('rejects elided evidence anywhere and preserves authored punctuation exactly once', () => {
		for (const [id, text] of [
			['unicode-ellipsis', 'The service… is open today.'],
			['ascii-ellipsis', 'The service ... is open today.'],
			['ascii-tail', 'The service is open... More details follow.']
		] as const) {
			expect(completeGroundedEvidenceStatement(source(id, text))).toBe('');
		}

		for (const [id, text, expected] of [
			['period', 'The service is open.', 'The service is open. [1]'],
			['exclamation', 'The service is open!', 'The service is open! [1]'],
			['question', 'Is the service open?', 'Is the service open? [1]'],
			['semicolon', 'The service is open;', 'The service is open; [1]'],
			['colon', 'The service is open:', 'The service is open: [1]'],
			['dash', 'The service is open —', 'The service is open — [1]']
		] as const) {
			const item = source(id, text);
			const ledger = normalizeGroundedEvidence([item]);
			const claimFromSource = groundedClaimFromEvidence(item, ledger);
			expect(claimFromSource).not.toBeNull();
			expect(renderGroundedAnswer(groundedAnswerFromClaims([claimFromSource!]), ledger)).toBe(expected);
		}

		const url = source('bare-url', 'https://example.test/releases/v1.2.3-beta');
		const urlLedger = normalizeGroundedEvidence([url]);
		const urlClaim = groundedClaimFromEvidence(url, urlLedger);
		expect(urlClaim).not.toBeNull();
		expect(renderGroundedAnswer(groundedAnswerFromClaims([urlClaim!]), urlLedger)).toBe(
			'https://example.test/releases/v1.2.3-beta [1]'
		);
	});

	it('supports short claims by exact token/phrase boundaries without substring collisions', () => {
		const evidence = [
			source('yes', 'Yes, the service is open.'),
			source('status', 'The status field is active.'),
			source('japanese', '東京で確認。現地当局が発表した。'),
			source('eyes', 'The eyes were examined.'),
			source('party', 'The party continued.'),
			source('statuses', 'Statuses were reviewed.')
		];
		const ledger = normalizeGroundedEvidence(evidence);

		expect(groundedClaimFromEvidence(evidence[0], ledger, { visibleText: 'Yes' })).not.toBeNull();
		expect(groundedClaimFromEvidence(evidence[1], ledger, { visibleText: 'status' })).not.toBeNull();
		expect(groundedClaimFromEvidence(evidence[2], ledger, { visibleText: '東京で確認。' })).not.toBeNull();
		expect(groundedClaimFromEvidence(evidence[3], ledger, { visibleText: 'Yes' })).toBeNull();
		expect(groundedClaimFromEvidence(evidence[4], ledger, { visibleText: 'art' })).toBeNull();
		expect(groundedClaimFromEvidence(evidence[5], ledger, { visibleText: 'status' })).toBeNull();
	});

	it('renders sections, bullets, headings, tables, wrappers, links, dates, and safe text from claim intent', () => {
		const evidence = [
			source('one', 'The status field is active.'),
			source('two', 'The address is 10 Main Street.'),
			source('three', 'A service update was posted today.')
		];
		const ledger = normalizeGroundedEvidence(evidence);
		const status = groundedClaimFromEvidence(evidence[0], ledger, {
			presentation: { kind: 'heading', level: 3, wrapper: 'code' }
		});
		const address = groundedClaimFromEvidence(evidence[1], ledger, {
			presentation: {
				kind: 'bullet',
				leadingText: 'Address',
				leadingStrong: true,
				trailingLabel: 'Source time',
				trailingText: '2026-08-08',
				wrapper: { kind: 'link', url: 'https://example.test/address' }
			}
		});
		const update = groundedClaimFromEvidence(evidence[2], ledger, {
			presentation: { kind: 'table-row', tableCells: ['Status', 'Active'] }
		});

		expect(status && address && update).toBeTruthy();
		expect(
			renderGroundedAnswer(
				groundedAnswerFromClaims([status!, address!, update!], [
					{ kind: 'section', heading: 'Research & findings', level: 2 },
					{ kind: 'claim', claim: status! },
					{ kind: 'claim', claim: address! },
					{ kind: 'claim', claim: update! }
				]),
				ledger
			)
		).toBe(
				'## Research & findings\n### `The status field is active.` [1]\n- **Address** [The address is 10 Main Street.](https://example.test/address) [2] **Source time:** 2026-08-08\n| Status | Active | A service update was posted today. [3] |'
		);
	});

	it('keeps supported short headings and inline code claims without inventing punctuation', () => {
		const headingEvidence = source('heading-status', '# Status');
		const codeEvidence = source('code-status', 'The status field is active.');
		const ledger = normalizeGroundedEvidence([headingEvidence, codeEvidence]);
		const heading = groundedClaimFromEvidence(headingEvidence, ledger, {
			visibleText: 'Status',
			presentation: { kind: 'heading', level: 2, structuredLabel: { label: 'Status' } }
		});
		const code = groundedClaimFromEvidence(codeEvidence, ledger, {
			visibleText: 'status',
			presentation: { wrapper: 'code' }
		});

		expect(heading && code).toBeTruthy();
		expect(
			renderGroundedAnswer(
				groundedAnswerFromClaims([heading!, code!]),
				ledger
			)
		).toBe('## Status [1]\n`status` [2]');
	});

	it('validates time abbreviations only as attached clock expressions', () => {
		const valid = [
			'The briefing starts at 7:30 p.m.',
			'The briefing starts at 7:30 A.M.',
			'The briefing starts at noon.',
			'The briefing starts at midnight.',
			'The briefing starts at 7:30 p.m. ET.'
		];
		for (const [index, text] of valid.entries()) {
			const item = source(`time-${index}`, text);
			const ledger = normalizeGroundedEvidence([item]);
			const grounded = groundedClaimFromEvidence(item, ledger);
			expect(grounded).not.toBeNull();
			expect(renderGroundedAnswer(groundedAnswerFromClaims([grounded!]), ledger)).toBe(`${text} [1]`);
		}

		for (const [index, text] of [
			'The event is at p.m.',
			'The event is at A.M.',
			'The event is at p.m. ET.',
			'The event starts at 7:30 p.m. and',
			'The event is at St.'
		].entries()) {
			const item = source(`invalid-time-${index}`, text);
			const ledger = normalizeGroundedEvidence([item]);
			expect(completeGroundedEvidenceStatement(item)).toBe('');
			expect(groundedClaimFromEvidence(item, ledger)).toBeNull();
		}
	});

	it('renders explicit structured labels and rejects label/value prefixes', () => {
		const evidence = [
			source('status-label', 'Status: Active'),
			source('bare-heading', '# Status'),
			source('status-prefix', 'Statuses were reviewed.'),
			source('value-prefix', 'Status: Active statuses were reviewed.')
		];
		const ledger = normalizeGroundedEvidence(evidence);
		const status = groundedClaimFromEvidence(evidence[0], ledger, {
			presentation: { structuredLabel: { label: 'Status', value: 'Active' } }
		});
		const heading = groundedClaimFromEvidence(evidence[1], ledger, {
			presentation: { kind: 'heading', level: 2, structuredLabel: { label: 'Status' } }
		});
		const bullet = groundedClaimFromEvidence(evidence[0], ledger, {
			claimId: 'status-bullet',
			presentation: { kind: 'bullet', structuredLabel: { label: 'Status', value: 'Active' } }
		});
		const table = groundedClaimFromEvidence(evidence[0], ledger, {
			claimId: 'status-table',
			presentation: { kind: 'table-row', tableCells: ['Field'], structuredLabel: { label: 'Status', value: 'Active' } }
		});

		expect(status && heading && bullet && table).toBeTruthy();
		expect(renderGroundedAnswer(groundedAnswerFromClaims([status!]), ledger)).toBe('Status: Active [1]');
		expect(renderGroundedAnswer(groundedAnswerFromClaims([heading!]), ledger)).toBe('## Status [1]');
		expect(renderGroundedAnswer(groundedAnswerFromClaims([bullet!]), ledger)).toBe('- Status: Active [1]');
		expect(renderGroundedAnswer(groundedAnswerFromClaims([table!]), ledger)).toBe('| Field | Status: Active [1] |');
		expect(
		groundedClaimFromEvidence(evidence[2], ledger, {
			presentation: { structuredLabel: { label: 'Status' } }
		})
		).toBeNull();
		expect(
			groundedClaimFromEvidence(evidence[3], ledger, {
				presentation: { structuredLabel: { label: 'Status', value: 'Active' } }
			})
		).toBeNull();
		expect(
			groundedClaimFromEvidence(evidence[0], ledger, {
				presentation: { structuredLabel: { label: 'Status' } }
			})
		).toBeNull();
	});

	it('drops raw provider markers from safe text blocks and never emits malformed markers', () => {
		const evidence = [source('one', 'The service is open.')];
		const ledger = normalizeGroundedEvidence(evidence);
		const answer = groundedAnswerFromClaims([], [
			{ kind: 'text', text: 'Provider prose [99] and malformed [1 should not be visible.' },
			{ kind: 'claim', claim: claim('ok', 'The service is open.', ['one']) }
		]);

		expect(renderGroundedAnswer(answer, ledger)).toBe('The service is open. [1]');
	});

	it.each([
		['paragraph', 'Alpha event happened today. [1]'],
		['bullet', '- Alpha event happened today. [1]'],
		['heading', '## Alpha event happened today. [1]'],
		['table-row', '| Alpha event happened today. [1] |']
	] as const)('renders one structured %s claim without line parsing', (kind, expected) => {
		const evidence = [source('alpha', 'Alpha event happened today.')];
		const ledger = normalizeGroundedEvidence(evidence);
		const rendered = groundedClaimFromEvidence(evidence[0], ledger, {
			presentation: { kind }
		});

		expect(rendered).not.toBeNull();
		expect(renderGroundedAnswer(groundedAnswerFromClaims([rendered!]), ledger)).toBe(expected);
	});

	it('reassembles one-to-three claims by block order, keeping uncited editorial text outside the ledger', () => {
		const evidence = [
			source('alpha', 'Alpha event happened today.'),
			source('beta', 'Beta event happened yesterday.'),
			source('gamma', 'Gamma event happened this morning.')
		];
		const ledger = normalizeGroundedEvidence(evidence);
		const claims = evidence.map((item, index) =>
			groundedClaimFromEvidence(item, ledger, {
				claimId: ['alpha', 'beta', 'gamma'][index],
				presentation: { kind: 'bullet' }
			})
		);

		expect(
			renderGroundedAnswer(
				groundedAnswerFromClaims(claims.filter(Boolean) as GroundedClaim[], [
					{ kind: 'text', text: 'Uncited lead.' },
					{ kind: 'claim', claim: claims[0]! },
					{ kind: 'text', text: 'Between note — and editorial suffix.' },
					{ kind: 'claim', claim: claims[1]! },
					{ kind: 'claim', claim: claims[2]! },
					{ kind: 'text', text: 'Closing note.' }
				]),
				ledger
			)
		).toBe(
			'Uncited lead.\n- Alpha event happened today. [1]\nBetween note — and editorial suffix.\n- Beta event happened yesterday. [2]\n- Gamma event happened this morning. [3]\nClosing note.'
		);
	});

	it('assigns citations by final visual claim order across mixed authorities and preserves duplicate identities', () => {
		const older = source('older', 'The older authority confirmed the original plan.', {
			source_kind: 'official',
			citation_number: 1
		});
		const newer = source('newer', 'The newer producer report confirmed the follow-up plan.', {
			source_kind: 'news_report',
			citation_number: 1
		});
		const duplicateOne = source('duplicate', 'The shared finding is confirmed by both sources.', {
			canonical_url: 'https://example.test/duplicate-one',
			source_url: 'https://example.test/duplicate-one'
		});
		const duplicateTwo = source('duplicate', 'The shared finding is confirmed by both sources.', {
			canonical_url: 'https://example.test/duplicate-two',
			source_url: 'https://example.test/duplicate-two'
		});
		const evidence = [older, newer, duplicateOne, duplicateTwo];
		const ledger = normalizeGroundedEvidence(evidence);
		const newerClaim = groundedClaimFromEvidence(newer, ledger, { presentation: { kind: 'bullet' } });
		const olderClaim = groundedClaimFromEvidence(older, ledger, { presentation: { kind: 'bullet' } });
		const sharedClaim = groundedClaimFromEvidence(duplicateOne, ledger, {
			visibleText: 'The shared finding is confirmed by both sources.',
			presentation: { kind: 'bullet' }
		});
		const duplicateTwoId = ledger.evidenceOrder.find((id) => id.startsWith('duplicate#'));

		expect(newerClaim && olderClaim && sharedClaim && duplicateTwoId).toBeTruthy();
		const rendered = renderGroundedAnswer(
			groundedAnswerFromClaims([newerClaim!, olderClaim!, sharedClaim!], [
				{ kind: 'section', heading: 'Newer producer authority', level: 3 },
				{ kind: 'claim', claim: newerClaim! },
				{ kind: 'section', heading: 'Older official authority', level: 3 },
				{ kind: 'claim', claim: olderClaim! },
				{
					kind: 'claim',
					claim: {
						...sharedClaim!,
						evidenceIds: [ledger.evidenceOrder[2], duplicateTwoId!]
					}
				},
				{ kind: 'source', title: 'Duplicate one', url: duplicateOne.source_url },
				{ kind: 'source', title: 'Duplicate two', url: duplicateTwo.source_url }
			]),
			ledger
		);

		expect(rendered).toContain('### Newer producer authority');
		expect(rendered.indexOf('The newer producer report')).toBeLessThan(rendered.indexOf('The older authority'));
		expect(rendered).toContain('The newer producer report confirmed the follow-up plan. [1]');
		expect(rendered).toContain('The older authority confirmed the original plan. [2]');
		expect(rendered).toContain('The shared finding is confirmed by both sources. [3] [4]');
		expect(rendered).toContain('https://example.test/duplicate-one');
		expect(rendered).toContain('https://example.test/duplicate-two');
		expect(evidence.map((item) => item.citation_number)).toEqual([2, 1, 3, 4]);
	});

	it('drops an unsupported structural claim instead of marker-only deletion or citation laundering', () => {
		const evidence = [source('unrelated', 'A different report covers another subject.')];
		const ledger = normalizeGroundedEvidence(evidence);
		const forms = [
			{ kind: 'bullet' as const },
			{ kind: 'heading' as const, level: 2 },
			{ kind: 'table-row' as const, tableCells: ['Status'] },
			{ kind: 'paragraph' as const, wrapper: 'strong' as const },
			{ kind: 'paragraph' as const, wrapper: 'emphasis' as const },
			{ kind: 'paragraph' as const, wrapper: 'code' as const },
			{ kind: 'paragraph' as const, wrapper: { kind: 'link' as const, url: 'https://example.test/original' } }
		];

		for (const presentation of forms) {
			const invalid = claim('unsupported', 'Alpha event happened', ['unrelated'], presentation);
			expect(renderGroundedAnswer(groundedAnswerFromClaims([invalid]), ledger)).toBe('');
		}
	});

	it('handles historical clipped, label, conjunction, no-terminal, and malformed examples as invalid records', () => {
		const evidence = [
			source('community', 'Community event: Toronto’s Salsa on St. Clair is hosting a community dance program this weekend.'),
			source('alpha', 'Alpha event happened today.'),
			source('beta', 'Beta event happened yesterday.')
		];
		const ledger = normalizeGroundedEvidence(evidence);
		const historical = [
			claim('community-clipped', 'Toronto’s Salsa on', ['community'], { kind: 'bullet' }),
			claim('label-clipped', 'Community event: Toronto’s Salsa on', ['community'], { kind: 'bullet' }),
			claim('no-terminal', 'Alpha event happened', ['alpha']),
			claim('malformed', 'Beta event happened [2', ['beta'])
		];

		for (const item of historical) expect(validateGroundedClaim(item, ledger)).toBe(false);
		expect(renderGroundedAnswer(groundedAnswerFromClaims(historical), ledger)).toContain(
			'Community event: Toronto’s Salsa on St. Clair is hosting a community dance program this weekend. [1]'
		);
		expect(renderGroundedAnswer(groundedAnswerFromClaims(historical), ledger)).toContain('Alpha event happened today. [2]');
		expect(renderGroundedAnswer(groundedAnswerFromClaims(historical), ledger)).toContain('Beta event happened yesterday. [3]');
	});

	it('keeps the legacy citation guard fail-closed instead of blessing free-form cited prose', () => {
		const evidence = [source('alpha', 'Alpha event happened today.')];

		expect(enforceFinalCitationIntegrity('Unrelated claim [1]', evidence)).toBe('Alpha event happened today. [1]');
		expect(enforceFinalCitationIntegrity('Unrelated claim [7]', evidence)).toBe('Alpha event happened today. [1]');
		expect(enforceFinalCitationIntegrity('Unrelated claim [1', evidence)).toBe('Alpha event happened today. [1]');
		expect(enforceFinalCitationIntegrity('A safe uncited note.', evidence)).toBe('A safe uncited note.');
	});

	it('guards sourced production paths against bypassing the structured renderer', () => {
		const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
		const answerSource = read('../src/agents/answer.ts');
		const toolsSource = read('../src/agents/default-tools.ts');
		const runtimeSource = read('../src/agents/runtime.ts');
		const agentSource = read('../src/agents/newsroom-agent.ts');

		expect(answerSource).toContain('renderGroundedAnswer');
		expect(toolsSource).toContain('groundedAnswerFromEvidence');
		expect(toolsSource).toContain('renderGroundedAnswer');
		expect(toolsSource).not.toContain('readOpenAiResponseStream');
		expect(toolsSource).not.toContain('readChatCompletionStream');
		expect(toolsSource).not.toContain('withProviderCitationMarkers');
		expect(toolsSource).not.toContain('reconcileDedupedCitationMarkers');
		expect(runtimeSource).toContain('citationRecordsFromEvidence');
		expect(runtimeSource).not.toContain('reconcileDocumentAndWebEvidence');
		expect(agentSource).toContain('generateFinalAnswer');
	});
});
