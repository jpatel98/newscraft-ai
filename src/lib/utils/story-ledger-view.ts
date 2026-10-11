import { LEDGER_STATUSES, type LedgerStatus } from './story-ledger';

/** Wire shape returned by GET /api/conversations/[id]/ledger and sent to the worker. */
export interface StoryLedgerClaimView {
	id: string;
	claim: string;
	status: LedgerStatus;
	attributed_to: string;
	citations: number[];
	date: string;
	needs_check: boolean;
	updated_at: string;
	first_seen_message_id?: string | null;
	last_updated_message_id?: string | null;
}

export const LEDGER_STATUS_LABELS: Record<LedgerStatus, string> = {
	confirmed: 'Confirmed',
	alleged: 'Alleged',
	reported: 'Reported',
	unverified: 'Unverified',
	retracted: 'Retracted'
};

export interface LedgerGroup {
	status: LedgerStatus;
	label: string;
	claims: StoryLedgerClaimView[];
}

/** Groups claims by status in newsroom order; empty groups are omitted. */
export function groupLedgerClaims(
	claims: readonly StoryLedgerClaimView[],
	options: { openChecksOnly?: boolean } = {}
): LedgerGroup[] {
	const visible = options.openChecksOnly ? claims.filter((claim) => claim.needs_check) : claims;
	return LEDGER_STATUSES.map((status) => ({
		status,
		label: LEDGER_STATUS_LABELS[status],
		claims: visible.filter((claim) => claim.status === status)
	})).filter((group) => group.claims.length > 0);
}

/** Plain-text brief grouped by status, for pasting into a rundown or chat. */
export function ledgerBrief(claims: readonly StoryLedgerClaimView[]): string {
	const groups = groupLedgerClaims(claims);
	if (!groups.length) return '';
	const sections = groups.map((group) => {
		const lines = group.claims.map((claim) => {
			const details = [
				claim.attributed_to ? `per ${claim.attributed_to}` : '',
				claim.date
			].filter(Boolean);
			const markers = claim.citations.map((number) => `[${number}]`).join('');
			return `- ${claim.claim}${details.length ? ` (${details.join(', ')})` : ''}${
				markers ? ` ${markers}` : ''
			}${claim.needs_check ? ' NEEDS CHECK' : ''}`;
		});
		return `${group.label.toUpperCase()}\n${lines.join('\n')}`;
	});
	return `STORY LEDGER\n\n${sections.join('\n\n')}\n`;
}
