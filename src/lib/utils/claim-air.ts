/**
 * The producer's view of a ledger claim: can it go to air, and how must it be
 * attributed. Pure, so the pane, the brief and the copy writer all agree.
 *
 *   Open checks          something is unsettled: hold it until a person clears it
 *   Safe to air          confirmed by an official source or two independent outlets
 *   Attribute carefully  reported or alleged: air only with the attribution phrase
 *   Don't air yet        unverified, or withdrawn
 */
import type { LedgerStatus } from './story-ledger';

export const AIR_BUCKETS = ['check', 'safe', 'careful', 'hold'] as const;
export type AirBucket = (typeof AIR_BUCKETS)[number];

export const AIR_BUCKET_LABELS: Record<AirBucket, string> = {
	check: 'Open checks',
	safe: 'Safe to air',
	careful: 'Attribute carefully',
	hold: "Don't air yet"
};

export interface AirSource {
	url: string;
	host: string;
	tier: string;
}

export interface AirClaim {
	status: LedgerStatus;
	attributed_to: string;
	needs_check: boolean;
	sources?: readonly AirSource[];
}

export function airBucket(claim: AirClaim): AirBucket {
	if (claim.needs_check) return 'check';
	if (claim.status === 'confirmed') return 'safe';
	if (claim.status === 'reported' || claim.status === 'alleged') return 'careful';
	return 'hold';
}

/** How newsrooms name common publishers on air; anything else is named by its site. */
const PUBLISHER_NAMES: [string, string][] = [
	['tps.ca', 'Toronto police'], ['torontopolice.on.ca', 'Toronto police'], ['opp.ca', 'Ontario Provincial Police'],
	['peelpolice.ca', 'Peel police'], ['yrp.ca', 'York Regional Police'], ['rcmp-grc.gc.ca', 'the RCMP'],
	['toronto.ca', 'the City of Toronto'], ['mississauga.ca', 'the City of Mississauga'], ['ttc.ca', 'the TTC'],
	['metrolinx.com', 'Metrolinx'], ['news.ontario.ca', 'the Ontario government'], ['ontario.ca', 'the Ontario government'],
	['pm.gc.ca', "the Prime Minister's Office"], ['canada.ca', 'the federal government'], ['ontariocourts.ca', 'court records'],
	['canlii.org', 'court records'], ['siu.on.ca', 'the SIU'], ['cpso.on.ca', 'the CPSO'],
	['cbc.ca', 'CBC News'], ['ctvnews.ca', 'CTV News'], ['cp24.com', 'CP24'], ['citynews.ca', 'CityNews'],
	['globalnews.ca', 'Global News'], ['theglobeandmail.com', 'The Globe and Mail'], ['thestar.com', 'the Toronto Star'],
	['thecanadianpress.com', 'The Canadian Press'], ['thecanadianpressnews.ca', 'The Canadian Press'],
	['nationalpost.com', 'the National Post'], ['torontosun.com', 'the Toronto Sun'], ['tsn.ca', 'TSN'],
	['sportsnet.ca', 'Sportsnet'], ['reuters.com', 'Reuters'], ['apnews.com', 'The Associated Press'], ['bbc.com', 'the BBC'],
	['bbc.co.uk', 'the BBC'], ['nytimes.com', 'The New York Times'], ['washingtonpost.com', 'The Washington Post'],
	['nhl.com', 'the NHL'], ['nba.com', 'the NBA'], ['raptors.com', 'the Raptors']
];

export function publisherName(host: string): string {
	const found = PUBLISHER_NAMES.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
	return found ? found[1] : host;
}

const PLURAL = /\b(?:police|officials|prosecutors|investigators|authorities|sources|officers|organizers|residents|witnesses|doctors|people)\b/i;
const TIER_ORDER = ['official', 'wire_major', 'local', 'other', 'aggregator'];

function verb(who: string, singular: string, plural: string): string {
	return PLURAL.test(who) ? plural : singular;
}

/** Who to credit on air: the ledger's own attribution, else the strongest cited publisher. */
export function creditFor(claim: AirClaim): string {
	if (claim.attributed_to.trim()) return claim.attributed_to.trim();
	const best = [...(claim.sources ?? [])].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))[0];
	return best ? publisherName(best.host) : '';
}

export interface Attribution {
	/** The phrase to lead with on air, e.g. "Toronto police allege". Empty when none is needed. */
	phrase: string;
	/** Wordings that keep the attribution; generated copy must use one of them for this claim. */
	allowed: string[];
	/** True when the claim may not be stated as plain fact. */
	required: boolean;
}

export function attributionFor(claim: AirClaim): Attribution {
	const who = creditFor(claim);
	switch (claim.status) {
		case 'confirmed':
			return {
				phrase: who ? `${who} ${verb(who, 'confirms', 'confirm')}` : '',
				allowed: who ? [`${who} ${verb(who, 'says', 'say')}`, `${who} ${verb(who, 'confirms', 'confirm')}`, `according to ${who}`] : [],
				required: false
			};
		case 'reported': {
			const credit = who || 'one outlet';
			return {
				phrase: `according to ${credit}`,
				allowed: [`according to ${credit}`, `${credit} ${verb(credit, 'reports', 'report')}`, `${credit} ${verb(credit, 'says', 'say')}`],
				required: true
			};
		}
		case 'alleged': {
			const credit = who || 'police';
			return {
				phrase: `${credit} ${verb(credit, 'alleges', 'allege')}`,
				allowed: [`${credit} ${verb(credit, 'alleges', 'allege')}`, `according to ${credit}`, 'allegedly', 'alleged', 'accused of', 'is charged with', 'are charged with', 'faces charges'],
				required: true
			};
		}
		case 'unverified':
			return { phrase: 'not confirmed', allowed: ['not confirmed', 'unconfirmed', 'has not been confirmed', 'could not confirm'], required: true };
		case 'retracted':
			return { phrase: 'withdrawn', allowed: ['withdrawn', 'retracted', 'no longer'], required: true };
	}
}
