import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveStatus, isStale, resolveEvidence, summarizeEvidence, type CitedPage } from './claim-evidence';
import { AGGREGATOR_DOMAINS, classifySource, LOCAL, OFFICIAL_DOMAINS, WIRE_MAJOR } from './source-tiers';

const pages = (...urls: string[]) => new Map<number, CitedPage>(urls.map((url, i) => [i + 1, { url, date: '2026-10-14' }]));
const evidence = (...urls: string[]) => resolveEvidence(urls.map((_, i) => i + 1), pages(...urls));

describe('classifySource', () => {
	it.each([
		['https://www.tps.ca/media-centre/news-releases/1', 'official'],
		['https://news.ontario.ca/en/release/1', 'official'],
		['https://www.canada.ca/en/news/1.html', 'official'],
		['https://desn.kyivcity.gov.ua/news/1', 'official'],
		['https://www.bajacalifornia.gob.mx/1', 'official'],
		['https://www.peelregionalpolice.ca/1', 'official'],
		['https://www.nhl.com/mapleleafs/news/1', 'official'],
		['https://www.cbc.ca/news/1', 'wire_major'],
		['https://toronto.citynews.ca/2026/10/14/1', 'wire_major'],
		['https://www.thecanadianpressnews.ca/1', 'wire_major'],
		['https://www.insauga.com/1', 'local'],
		['https://www.villagereport.ca/1', 'local'],
		['https://ca.news.yahoo.com/1', 'aggregator'],
		['https://www.msn.com/en-ca/news/1', 'aggregator'],
		['https://en.wikipedia.org/wiki/1', 'aggregator'],
		['https://hoopsrumors.com/1', 'other'],
		['not a url', 'other']
	])('%s is %s', (url, tier) => {
		expect(classifySource(url).tier).toBe(tier);
	});

	it('groups outlets by owner so CTV and CP24 are one voice', () => {
		expect(classifySource('https://www.ctvnews.ca/1').publisher).toBe(classifySource('https://www.cp24.com/1').publisher);
		expect(classifySource('https://www.cbc.ca/1').publisher).not.toBe(classifySource('https://globalnews.ca/1').publisher);
	});

	it('agrees with the worker on every domain both lists name', () => {
		const python = readFileSync(new URL('../../../services/hermes-chat/src/hermes_chat/source_tiers.py', import.meta.url), 'utf8');
		const tuple = (name: string) =>
			[...(python.match(new RegExp(`${name} = \\(([\\s\\S]*?)\\n\\)`))?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		const expectTier = (domains: string[], tier: string) => {
			expect(domains.length).toBeGreaterThan(5);
			for (const domain of domains) expect(classifySource(`https://${domain}/x`).tier, domain).toBe(tier);
		};
		expectTier(tuple('OFFICIAL_DOMAINS'), 'official');
		expectTier(tuple('MAJOR_DOMAINS'), 'wire_major');
		expectTier(tuple('LOCAL_DOMAINS'), 'local');
		expectTier(tuple('AGGREGATOR_DOMAINS'), 'aggregator');
		// And every app list entry is classified as its own list says.
		for (const domain of OFFICIAL_DOMAINS) expect(classifySource(`https://${domain}/x`).tier, domain).toBe('official');
		for (const domain of Object.keys(WIRE_MAJOR)) expect(classifySource(`https://${domain}/x`).tier, domain).toBe('wire_major');
		for (const domain of Object.keys(LOCAL)) expect(classifySource(`https://${domain}/x`).tier, domain).toBe('local');
		for (const domain of AGGREGATOR_DOMAINS) expect(classifySource(`https://${domain}/x`).tier, domain).toBe('aggregator');
	});
});

describe('status from evidence', () => {
	it('confirms on an official source', () => {
		expect(deriveStatus('reported', evidence('https://www.tps.ca/1'), false)).toBe('confirmed');
	});

	it('confirms on two independent wire/major outlets but not two from one owner', () => {
		expect(deriveStatus('confirmed', evidence('https://www.cbc.ca/1', 'https://globalnews.ca/1'), false)).toBe('confirmed');
		expect(deriveStatus('confirmed', evidence('https://www.ctvnews.ca/1', 'https://www.cp24.com/1'), false)).toBe('reported');
	});

	it('one tier-2 outlet is reported, aggregators alone are unverified', () => {
		expect(deriveStatus('confirmed', evidence('https://www.cbc.ca/1'), false)).toBe('reported');
		expect(deriveStatus('confirmed', evidence('https://ca.news.yahoo.com/1', 'https://www.msn.com/1'), false)).toBe('unverified');
		expect(deriveStatus('confirmed', [], false)).toBe('unverified');
	});

	it('keeps alleged, retracted and unverified, and caps a contradicted claim at reported', () => {
		const official = evidence('https://www.tps.ca/1');
		expect(deriveStatus('alleged', official, false)).toBe('alleged');
		expect(deriveStatus('retracted', official, false)).toBe('retracted');
		expect(deriveStatus('unverified', official, false)).toBe('unverified');
		expect(deriveStatus('confirmed', official, true)).toBe('reported');
	});

	it('keeps tier and corroboration as separate numbers', () => {
		expect(summarizeEvidence(evidence('https://www.tps.ca/1', 'https://www.cbc.ca/1', 'https://www.msn.com/1'))).toEqual({
			tier: 'official',
			corroboration: 2,
			ceiling: 'confirmed'
		});
	});

	it('drops citation numbers the answer did not list', () => {
		expect(resolveEvidence([1, 7], pages('https://www.cbc.ca/1')).map((s) => s.n)).toEqual([1]);
	});

	it('flags only claims whose newest date is older than six months', () => {
		const at = Date.UTC(2026, 9, 15);
		const old = resolveEvidence([1], new Map([[1, { url: 'https://www.cbc.ca/1', date: '2025-09-02' }]]));
		const fresh = resolveEvidence([1], new Map([[1, { url: 'https://www.cbc.ca/2', date: '2026-10-01' }]]));
		expect(isStale(old, '', at)).toBe(true);
		expect(isStale([...old, ...fresh], '', at)).toBe(false);
		expect(isStale([], '', at)).toBe(false);
		expect(isStale([], '2024-01-01', at)).toBe(true);
	});
});
