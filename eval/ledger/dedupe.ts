/**
 * One-off backfill: merge paraphrased duplicates already stored in story_claims
 * (rows written before the event log existed). Works from an export of the
 * rows and a judge, and emits reviewable SQL to run inside the database
 * container, so nothing connects to production from here.
 */
import { foldClaim, planTurn, type ClaimEvent, type ClaimState } from '../../src/lib/utils/claim-events';
import { matchIncoming, type ClaimJudge } from '../../src/lib/utils/claim-matcher';
import type { LedgerClaim, LedgerStatus } from '../../src/lib/utils/story-ledger';

export interface ExportedClaimRow {
	id: string;
	conversation_id: string;
	claim: string;
	status: LedgerStatus;
	attributed_to: string;
	citation_numbers: number[];
	publication_date: string;
	needs_check: boolean;
	first_seen_message_id: string | null;
	last_updated_message_id: string | null;
	superseded_by: string | null;
	reviewed_by?: string | null;
	reviewed_at?: number | null;
	created_at: number;
	updated_at: number;
}

export interface DedupePlan {
	merges: { from: string; into: string; fromText: string; intoText: string }[];
	conflicts: { a: string; b: string; aText: string; bText: string }[];
	statements: string[];
}

const q = (value: string | null | undefined) => (value == null ? 'NULL' : `'${value.replace(/'/g, "''")}'`);
const j = (value: unknown) => `${q(JSON.stringify(value))}::jsonb`;

function stateOf(row: ExportedClaimRow): ClaimState {
	const events: ClaimEvent[] = [
		{
			claimId: row.id,
			kind: 'asserted',
			actor: 'model',
			actorName: '',
			messageId: row.first_seen_message_id,
			data: { text: row.claim, status: row.status, attributed_to: row.attributed_to, citations: row.citation_numbers, date: row.publication_date },
			at: row.created_at
		}
	];
	if (row.needs_check) events.push({ ...events[0], kind: 'check_opened', data: { reason: row.reviewed_at ? 'person' : 'model' } });
	const state = foldClaim(row.id, events);
	return { ...state, reviewedBy: row.reviewed_by ?? null, reviewedAt: row.reviewed_at ?? null, updatedAt: row.updated_at };
}

function asIncoming(row: ExportedClaimRow): LedgerClaim {
	return {
		claim: row.claim,
		status: row.status,
		attributedTo: row.attributed_to,
		citations: row.citation_numbers,
		date: row.publication_date,
		needsCheck: row.needs_check
	};
}

export async function planDedupe(rows: readonly ExportedClaimRow[], judge: ClaimJudge | null, now: number, newId: () => string): Promise<DedupePlan> {
	const plan: DedupePlan = { merges: [], conflicts: [], statements: [] };
	const byConversation = new Map<string, ExportedClaimRow[]>();
	for (const row of rows) if (!row.superseded_by) byConversation.set(row.conversation_id, [...(byConversation.get(row.conversation_id) ?? []), row]);
	for (const [conversationId, list] of byConversation) {
		const canonical = new Map<string, ClaimState>();
		for (const row of [...list].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))) {
			const [match] = (await matchIncoming([...canonical.values()], [asIncoming(row)], judge)).matches;
			const target = match.kind === 'same' ? canonical.get(match.claimId) : undefined;
			// A row a person reviewed is never folded into another one.
			if (target && !row.reviewed_at) {
				const turn = planTurn({
					active: [target],
					incoming: [asIncoming(row)],
					matches: [{ kind: 'same', claimId: target.id, how: 'judge' }],
					messageId: row.last_updated_message_id,
					at: now,
					newId
				});
				const next = turn.touched.get(target.id)!;
				canonical.set(target.id, next);
				plan.merges.push({ from: row.id, into: target.id, fromText: row.claim, intoText: target.claim });
				for (const event of turn.events) {
					const data = event.kind === 'asserted' ? { ...event.data, merged_from: row.id, backfill: true } : { ...event.data, backfill: true };
					plan.statements.push(
						`INSERT INTO story_claim_events (id, conversation_id, claim_id, kind, actor, actor_name, message_id, data, created_at) VALUES (${q(newId())}, ${q(conversationId)}, ${q(event.claimId)}, ${q(event.kind)}, 'system', '', ${q(event.messageId)}, ${j(data)}, ${now});`
					);
				}
				plan.statements.push(
					`INSERT INTO story_claim_variants (id, conversation_id, claim_id, text, message_id, created_at) VALUES (${q(newId())}, ${q(conversationId)}, ${q(target.id)}, ${q(row.claim)}, ${q(row.first_seen_message_id)}, ${now}) ON CONFLICT DO NOTHING;`,
					`UPDATE story_claims SET superseded_by = ${q(target.id)}, updated_at = ${now} WHERE id = ${q(row.id)} AND superseded_by IS NULL;`,
					`UPDATE story_claims SET claim = ${q(next.claim)}, status = ${q(next.status)}, attributed_to = ${q(next.attributedTo)}, citation_numbers = ${j(next.citations)}, publication_date = ${q(next.date)}, needs_check = ${next.needsCheck}, updated_at = ${now} WHERE id = ${q(target.id)};`
				);
				continue;
			}
			const state = stateOf(row);
			canonical.set(row.id, state);
			if (match.kind === 'contradicts') {
				const other = canonical.get(match.claimId)!;
				plan.conflicts.push({ a: other.id, b: row.id, aText: other.claim, bText: row.claim });
				for (const [claimId, by] of [[row.id, other.id], [other.id, row.id]]) {
					plan.statements.push(
						`INSERT INTO story_claim_events (id, conversation_id, claim_id, kind, actor, actor_name, message_id, data, created_at) VALUES (${q(newId())}, ${q(conversationId)}, ${q(claimId)}, 'contradicted', 'system', '', NULL, ${j({ by, backfill: true })}, ${now});`
					);
				}
			}
		}
	}
	return plan;
}
