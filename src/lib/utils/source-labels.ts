/**
 * Short, human labels for where a source came from and when it was published,
 * used on citation chips and the per-answer source row.
 */

const OUTLETS: Record<string, string> = {
	'apnews.com': 'AP News',
	'bbc.com': 'BBC News',
	'bbc.co.uk': 'BBC News',
	'bloomberg.com': 'Bloomberg',
	'cbc.ca': 'CBC News',
	'cnn.com': 'CNN',
	'cp24.com': 'CP24',
	'ctvnews.ca': 'CTV News',
	'citynews.ca': 'CityNews',
	'theglobeandmail.com': 'The Globe and Mail',
	'globalnews.ca': 'Global News',
	'thestar.com': 'Toronto Star',
	'torontosun.com': 'Toronto Sun',
	'nationalpost.com': 'National Post',
	'thecanadianpressnews.ca': 'The Canadian Press',
	'canadianpress.com': 'The Canadian Press',
	'blogto.com': 'blogTO',
	'insauga.com': 'inSauga',
	'nytimes.com': 'The New York Times',
	'washingtonpost.com': 'The Washington Post',
	'wsj.com': 'The Wall Street Journal',
	'theguardian.com': 'The Guardian',
	'reuters.com': 'Reuters',
	'npr.org': 'NPR',
	'politico.com': 'Politico',
	'axios.com': 'Axios',
	'canada.ca': 'Government of Canada',
	'ontario.ca': 'Government of Ontario',
	'news.ontario.ca': 'Government of Ontario',
	'toronto.ca': 'City of Toronto',
	'statcan.gc.ca': 'Statistics Canada',
	'www150.statcan.gc.ca': 'Statistics Canada',
	'ourcommons.ca': 'House of Commons',
	'pm.gc.ca': 'Prime Minister of Canada',
	'tps.ca': 'Toronto Police Service'
};

function hostOf(domain: string): string | null {
	const value = domain.trim().toLowerCase();
	if (!value) return null;
	try {
		if (/^https?:\/\//.test(value)) return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return null;
	}
	return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value) ? value.replace(/^www\./, '') : null;
}

/**
 * The outlet name for a source domain ("cbc.ca" -> "CBC News"). Unknown web
 * domains fall back to the bare host; non-web labels such as "Attached
 * document" pass through unchanged.
 */
export function outletLabel(domain: string | null | undefined): string {
	const raw = (domain ?? '').trim();
	const host = hostOf(raw);
	if (!host) return raw;
	const parts = host.split('.');
	for (let i = 0; i < parts.length - 1; i++) {
		const candidate = parts.slice(i).join('.');
		if (OUTLETS[candidate]) return OUTLETS[candidate];
	}
	return host;
}

function parseSourceDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	const parsed = dateOnly
		? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
		: new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "Oct 12" for this year, "Oct 12, 2025" otherwise, "Date unknown" when missing. */
export function shortSourceDateLabel(value: string | null | undefined, now: Date = new Date()): string {
	const parsed = parseSourceDate(value);
	if (!parsed) return value ? value : 'Date unknown';
	const sameYear = parsed.getFullYear() === now.getFullYear();
	return new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' })
	}).format(parsed);
}

/** Newest first; undated sources keep their order at the end. */
export function sortNewestFirst<T extends { publicationDate: string | null }>(items: ReadonlyArray<T>): T[] {
	return items
		.map((item, index) => ({ item, index, time: parseSourceDate(item.publicationDate)?.getTime() ?? null }))
		.sort((left, right) => {
			if (left.time === null && right.time === null) return left.index - right.index;
			if (left.time === null) return 1;
			if (right.time === null) return -1;
			return right.time - left.time || left.index - right.index;
		})
		.map(({ item }) => item);
}
