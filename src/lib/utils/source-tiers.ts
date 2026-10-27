/**
 * Source tiers for the story ledger: how much a cited page can establish.
 *
 *   official (1) > wire_major (2) > local (3) > other (4) > aggregator (5)
 *
 * The Canadian official list covers federal, provincial and municipal
 * governments, police services, courts, regulators, Crown agencies and
 * election bodies. Outlets are grouped by owner, because CTV and CP24 (Bell)
 * or two Postmedia papers are not independent corroboration of each other.
 * The worker keeps its own ranking list (newscraft_agent/source_tiers.py); a test
 * keeps the two from disagreeing on the domains both name.
 */

export const SOURCE_TIERS = ['official', 'wire_major', 'local', 'other', 'aggregator'] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

/** Canadian (and a few international) official publishers, matched as the host or a subdomain. */
export const OFFICIAL_DOMAINS = [
	// Federal
	'canada.ca', 'gc.ca', 'parl.ca', 'ourcommons.ca', 'sencanada.ca', 'pm.gc.ca', 'elections.ca', 'statcan.gc.ca',
	'bankofcanada.ca', 'rcmp-grc.gc.ca', 'scc-csc.ca', 'fca-caf.ca', 'fct-cf.ca', 'tsb-bst.gc.ca', 'cnsc-ccsn.gc.ca',
	'cer-rec.gc.ca', 'crtc.gc.ca', 'osfi-bsif.gc.ca', 'budget.canada.ca', 'cbsa-asfc.gc.ca', 'forces.gc.ca',
	// Provinces and territories
	'ontario.ca', 'news.ontario.ca', 'ola.org', 'elections.on.ca', 'gov.bc.ca', 'leg.bc.ca', 'alberta.ca', 'assembly.ab.ca',
	'saskatchewan.ca', 'gov.mb.ca', 'gov.mb.ca', 'quebec.ca', 'gouv.qc.ca', 'assnat.qc.ca', 'gnb.ca', 'novascotia.ca',
	'nslegislature.ca', 'princeedwardisland.ca', 'gov.pe.ca', 'gov.nl.ca', 'yukon.ca', 'gov.nt.ca', 'gov.nu.ca',
	// Ontario agencies, regulators, transit
	'cpso.on.ca', 'siu.on.ca', 'ipc.on.ca', 'ombudsman.on.ca', 'auditor.on.ca', 'oeb.ca', 'tribunalsontario.ca',
	'ontariocourts.ca', 'ttc.ca', 'metrolinx.com', 'gotransit.com', 'publichealthontario.ca', 'hqontario.ca', 'agco.ca',
	// Courts and legal records
	'canlii.org', 'courts.ca', 'scc-csc.lexum.com', 'bccourts.ca', 'albertacourts.ca', 'courtsofnl.ca',
	// Police services
	'tps.ca', 'torontopolice.on.ca', 'opp.ca', 'peelpolice.ca', 'yrp.ca', 'drps.ca', 'durhampolice.ca', 'haltonpolice.ca',
	'hamiltonpolice.on.ca', 'ottawapolice.ca', 'londonpolice.ca', 'wrps.on.ca', 'niagarapolice.ca', 'spvm.qc.ca',
	'sq.gouv.qc.ca', 'vpd.ca', 'calgary.ca', 'edmontonpolice.ca', 'winnipeg.ca', 'halifax.ca',
	// Municipalities (GTA and major cities)
	'toronto.ca', 'mississauga.ca', 'brampton.ca', 'markham.ca', 'vaughan.ca', 'richmondhill.ca', 'oakville.ca',
	'burlington.ca', 'hamilton.ca', 'pickering.ca', 'ajax.ca', 'oshawa.ca', 'whitby.ca', 'durham.ca', 'peelregion.ca',
	'halton.ca', 'york.ca', 'ottawa.ca', 'montreal.ca', 'vancouver.ca', 'edmonton.ca', 'london.ca', 'kitchener.ca',
	'waterloo.ca', 'guelph.ca', 'barrie.ca',
	// Health and public agencies
	'pearsonairport.com', 'gtaa.com', 'cihi.ca', 'phac-aspc.gc.ca',
	// International official
	'who.int', 'un.org', 'europa.eu', 'nato.int', 'whitehouse.gov', 'defense.gov', 'state.gov', 'gov.uk', 'gov.au'
] as const;

/** Suffixes that mark a government host anywhere (e.g. *.gc.ca, *.gov, *.gov.uk). */
const OFFICIAL_SUFFIXES = ['.gc.ca', '.gov', '.gouv.qc.ca', '.gov.on.ca', '.gov.uk', '.gov.au', '.gov.bc.ca', '.mil'];
/** Other countries' government hosts: *.gov.ua, *.gob.mx, *.gouv.fr, *.govt.nz. */
const FOREIGN_GOVERNMENT = /\.(?:gov|gob|gouv|govt|go)\.[a-z]{2}$/;

/**
 * First-party publishers: an organization's own channel is the official record
 * of what that organization says or decides (a league's injury report, a
 * pollster's own numbers, a professional body's statement).
 */
export const FIRST_PARTY_DOMAINS = [
	'nhl.com', 'nba.com', 'mlb.com', 'nfl.com', 'mls.com', 'mlssoccer.com', 'cfl.ca', 'wnba.com', 'pwhl.com', 'thepwhl.com',
	'raptors.com', 'mlse.com', 'tfc.ca', 'argonauts.ca', 'fifa.com', 'olympics.com', 'olympic.ca', 'paralympic.ca',
	'canadasoccer.com', 'hockeycanada.ca', 'liaison.ca', 'mainstreetresearch.ca', 'angusreid.org', 'abacusdata.ca',
	'nanos.co', 'leger360.com', 'ipsos.com', 'cma.ca', 'cna-aiic.ca', 'oma.org', 'rnao.ca', 'redcross.ca', 'redcross.org'
] as const;
const OFFICIAL_LABEL = /^(?:[a-z0-9-]*police(?:services?)?|[a-z0-9-]*courts?)$/;

/** Wire services and major national/international outlets, with their owner for independence. */
export const WIRE_MAJOR: Record<string, string> = {
	'thecanadianpress.com': 'canadian-press', 'thecanadianpressnews.ca': 'canadian-press', 'cp24.com': 'bell', 'ctvnews.ca': 'bell', 'bnnbloomberg.ca': 'bell',
	'tsn.ca': 'bell', 'cbc.ca': 'cbc', 'radio-canada.ca': 'cbc', 'globalnews.ca': 'corus', 'citynews.ca': 'rogers',
	'sportsnet.ca': 'rogers', 'macleans.ca': 'rogers', 'theglobeandmail.com': 'globe', 'thestar.com': 'torstar',
	'nationalpost.com': 'postmedia', 'financialpost.com': 'postmedia', 'lapresse.ca': 'lapresse', 'ledevoir.com': 'ledevoir',
	'tvo.org': 'tvo', 'reuters.com': 'reuters', 'apnews.com': 'ap', 'afp.com': 'afp', 'bbc.com': 'bbc', 'bbc.co.uk': 'bbc',
	'nytimes.com': 'nyt', 'washingtonpost.com': 'wapo', 'wsj.com': 'dowjones', 'bloomberg.com': 'bloomberg', 'ft.com': 'ft',
	'theguardian.com': 'guardian', 'npr.org': 'npr', 'cnn.com': 'cnn', 'nbcnews.com': 'nbc', 'cbsnews.com': 'cbs',
	'abcnews.go.com': 'abc', 'aljazeera.com': 'aljazeera', 'politico.com': 'politico', 'axios.com': 'axios',
	'espn.com': 'disney', 'upi.com': 'upi', 'thehill.com': 'nexstar', 'stripes.com': 'stripes', 'euronews.com': 'euronews',
	'kyivindependent.com': 'kyiv-independent', 'ukrinform.net': 'ukrinform', 'interfax.com.ua': 'interfax',
	'europapress.es': 'europa-press', 'efe.com': 'efe', 'elpais.com': 'prisa', 'eluniversal.com.mx': 'el-universal',
	'jornada.com.mx': 'la-jornada', 'dw.com': 'dw', 'france24.com': 'france-medias-monde', 'lemonde.fr': 'le-monde',
	'spiegel.de': 'spiegel', 'abc.net.au': 'abc-au', 'cbc.radio-canada.ca': 'cbc', 'rferl.org': 'rferl'
};

/** Local and regional outlets (owner given where a chain owns several). */
export const LOCAL: Record<string, string> = {
	'torontosun.com': 'postmedia', 'ottawacitizen.com': 'postmedia', 'montrealgazette.com': 'postmedia',
	'vancouversun.com': 'postmedia', 'calgaryherald.com': 'postmedia', 'edmontonjournal.com': 'postmedia',
	'lfpress.com': 'postmedia', 'thespec.com': 'torstar', 'insidehalton.com': 'metroland', 'durhamregion.com': 'metroland',
	'yorkregion.com': 'metroland', 'mississauga.com': 'metroland', 'insauga.com': 'insauga', 'blogto.com': 'blogto',
	'narcity.com': 'narcity', 'urbantoronto.ca': 'urbantoronto', 'torontolife.com': 'torontolife', 'nowtoronto.com': 'now',
	'winnipegfreepress.com': 'freepress', 'thestarphoenix.com': 'postmedia', 'timescolonist.com': 'glacier'
};

export const AGGREGATOR_DOMAINS = [
	'the1news.com', 'newsbreak.com', 'ground.news', 'msn.com', 'news.yahoo.com', 'ca.news.yahoo.com', 'yahoo.com',
	'flipboard.com', 'headtopics.com', 'newsnow.co.uk', 'newsnow.com', 'feedly.com', 'inkl.com', 'pressreader.com',
	'news.google.com', 'smartnews.com', 'biztoc.com', 'upday.com', 'opera.news', 'newsinlevels.com', 'wn.com',
	'newsglobalcanada.com', 'x.com', 'twitter.com', 'facebook.com', 'reddit.com', 'tiktok.com', 'instagram.com',
	'wikipedia.org'
] as const;

export function hostOf(url: string): string {
	try {
		const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
		return host.startsWith('www.') ? host.slice(4) : host;
	} catch {
		return '';
	}
}

function within(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

function lookup(host: string, table: Record<string, string>): [string, string] | null {
	for (const [domain, owner] of Object.entries(table)) if (within(host, domain)) return [domain, owner];
	return null;
}

function secondLevel(host: string): string {
	const labels = host.split('.');
	if (labels.length >= 3 && ['co', 'com', 'on', 'gc', 'gov', 'gob', 'org', 'qc', 'bc', 'ab'].includes(labels.at(-2)!)) return labels.at(-3)!;
	return labels.length >= 2 ? labels.at(-2)! : host;
}

export interface SourceClass {
	host: string;
	tier: SourceTier;
	/** Who stands behind the page; two sources with the same publisher are one voice. */
	publisher: string;
}

export function classifySource(url: string): SourceClass {
	const host = hostOf(url);
	if (!host) return { host, tier: 'other', publisher: url };
	if (AGGREGATOR_DOMAINS.some((domain) => within(host, domain))) return { host, tier: 'aggregator', publisher: host };
	const official = OFFICIAL_DOMAINS.find((domain) => within(host, domain));
	if (
		official ||
		OFFICIAL_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
		FOREIGN_GOVERNMENT.test(host) ||
		OFFICIAL_LABEL.test(secondLevel(host))
	) {
		return { host, tier: 'official', publisher: official ?? host };
	}
	const firstParty = FIRST_PARTY_DOMAINS.find((domain) => within(host, domain));
	if (firstParty) return { host, tier: 'official', publisher: firstParty };
	const major = lookup(host, WIRE_MAJOR);
	if (major) return { host, tier: 'wire_major', publisher: major[1] };
	const local = lookup(host, LOCAL);
	if (local) return { host, tier: 'local', publisher: local[1] };
	if (host.endsWith('.ca')) return { host, tier: 'local', publisher: host };
	return { host, tier: 'other', publisher: host };
}

export const TIER_RANK: Record<SourceTier, number> = { official: 1, wire_major: 2, local: 3, other: 4, aggregator: 5 };
