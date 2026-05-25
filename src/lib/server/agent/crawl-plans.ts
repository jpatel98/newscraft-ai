import type { CrawlPlanCandidateLink, CrawlPlanProposal } from '$lib/types';

const MAX_BODY_CHARS = 750_000;
const MAX_CANDIDATE_LINKS = 12;
const USER_AGENT = 'NewsCraft crawl-plan-inspector/0.1 (+https://newscraft.ai)';

interface DraftCrawlPlanInput {
	seedUrl: string;
	missionSchedule?: string | null;
}

export type CrawlPlanDraft = Omit<
	CrawlPlanProposal,
	'id' | 'missionId' | 'status' | 'createdAt' | 'updatedAt' | 'approvedAt' | 'rejectedAt'
> & {
	plan: Record<string, unknown>;
};

export async function draftCrawlPlan(input: DraftCrawlPlanInput): Promise<CrawlPlanDraft> {
	const seedUrl = validateSeedUrl(input.seedUrl);
	const response = await fetch(seedUrl, {
		headers: { 'user-agent': USER_AGENT },
		signal: AbortSignal.timeout(10_000)
	});
	const body = (await response.text()).slice(0, MAX_BODY_CHARS);
	if (!response.ok) {
		throw new Error(`Seed page returned ${response.status}`);
	}
	const siteName = extractPageTitle(body) || new URL(seedUrl).hostname.replace(/^www\./, '');
	const candidateLinks = extractCandidateLinks(body, seedUrl);
	const linkFollowRule = suggestedLinkFollowRule(seedUrl);
	const pollingCadence = input.missionSchedule?.trim() || 'inherit mission schedule';
	const plan = {
		seedUrls: [seedUrl],
		linkFollowRule,
		articleBodyStrategy: 'auto',
		pollingCadence,
		changeDetection: 'hash',
		candidateLinks
	};

	return {
		seedUrl,
		siteName,
		linkFollowRule,
		articleBodyStrategy: 'auto',
		pollingCadence,
		changeDetection: 'hash',
		candidateLinks,
		plan
	};
}

export async function refreshCrawlPlanCandidates(plan: CrawlPlanProposal): Promise<CrawlPlanCandidateLink[]> {
	const draft = await draftCrawlPlan({
		seedUrl: plan.seedUrl,
		missionSchedule: plan.pollingCadence
	});
	return draft.candidateLinks;
}

function validateSeedUrl(value: string): string {
	const raw = value.trim();
	if (!raw) throw new Error('Seed URL is required');
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error('Seed URL must be a valid URL');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('Seed URL must start with http:// or https://');
	}
	parsed.hash = '';
	return parsed.toString();
}

function suggestedLinkFollowRule(seedUrl: string): string {
	const parsed = new URL(seedUrl);
	const path = parsed.pathname === '/' ? parsed.hostname : parsed.pathname.replace(/\/$/, '');
	return `Follow same-site links under ${path} that look like articles, releases, announcements, reports, or posts added since the last run.`;
}

function extractCandidateLinks(html: string, seedUrl: string): CrawlPlanCandidateLink[] {
	const seen = new Set<string>();
	const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
		.map((match, index) => {
			const href = attrValue(match[1], 'href');
			const title = normalizeWhitespace(decodeEntities(stripTags(match[2])));
			if (!href || !title) return null;
			const url = absoluteHref(href, seedUrl);
			if (!url || seen.has(url)) return null;
			seen.add(url);
			const score = candidateScore(title, url, seedUrl);
			if (score < 4) return null;
			return {
				title: trimTitle(title),
				url,
				reason: candidateReason(url, seedUrl),
				score,
				index
			};
		})
		.filter(
			(
				link
			): link is CrawlPlanCandidateLink & {
				index: number;
			} => Boolean(link)
		)
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.slice(0, MAX_CANDIDATE_LINKS);

	return links.map(({ index: _index, ...link }) => link);
}

function candidateScore(title: string, url: string, seedUrl: string): number {
	const parsed = new URL(url);
	const seed = new URL(seedUrl);
	const normalizedTitle = title.toLowerCase();
	const path = parsed.pathname.toLowerCase();
	let score = 0;

	if (parsed.hostname === seed.hostname) score += 4;
	else if (parsed.hostname.endsWith(`.${seed.hostname}`) || seed.hostname.endsWith(`.${parsed.hostname}`)) score += 2;
	else score -= 4;

	if (title.length >= 28 && title.length <= 160) score += 3;
	if (title.split(/\s+/).filter(Boolean).length >= 5) score += 2;
	if (/\b(news|article|story|release|announcements?|reports?|updates?|press|media|blog|posts?)\b/.test(path)) score += 2;
	if (/\b(says?|announces?|launches|approves|warns?|reports?|opens?|closes?|plans?|faces?|after|before)\b/.test(normalizedTitle)) {
		score += 1;
	}
	if (/\b(privacy|terms|login|signin|account|subscribe|contact|about|advertis|careers?)\b/.test(path)) score -= 4;
	if (/\b(skip to|sign in|subscribe|privacy|terms|contact us|newsletter|advertise)\b/.test(normalizedTitle)) {
		score -= 5;
	}
	if (/^https?:\/\//i.test(title)) score -= 3;
	return score;
}

function candidateReason(url: string, seedUrl: string): string {
	const parsed = new URL(url);
	const seed = new URL(seedUrl);
	if (parsed.hostname === seed.hostname) return 'Same-site story candidate';
	return 'Related-site story candidate';
}

function absoluteHref(href: string, seedUrl: string): string | null {
	if (/^(?:javascript|mailto|tel):/i.test(href) || href.startsWith('#')) return null;
	try {
		const parsed = new URL(href, seedUrl);
		parsed.hash = '';
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		return parsed.toString();
	} catch {
		return null;
	}
}

function attrValue(attrs: string, name: string): string | null {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = attrs.match(new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, 'i'));
	return match ? decodeEntities(match[1]).trim() : null;
}

function extractPageTitle(html: string): string | null {
	return (
		tagText(html, 'title') ||
		metaContent(html, 'og:title') ||
		metaContent(html, 'twitter:title')
	);
}

function tagText(body: string, tag: string): string | null {
	const match = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
	return match ? normalizeWhitespace(decodeEntities(stripTags(match[1]))) : null;
}

function metaContent(body: string, property: string): string | null {
	const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = body.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'));
	return match ? normalizeWhitespace(decodeEntities(match[1])) : null;
}

function stripTags(value: string): string {
	return value.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ');
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function trimTitle(value: string): string {
	return value.length <= 140 ? value : `${value.slice(0, 137).trim()}...`;
}

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}
