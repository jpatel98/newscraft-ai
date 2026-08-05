import { dedupeEvidence, isUsableEvidence, type EvidenceObject } from './evidence.js';

/**
 * Request-owned normalized evidence ledger. Discovery leads stay in the same
 * ledger as accepted evidence, but only accepted/readable items are exposed
 * to final synthesis. The ledger is deliberately ephemeral and never writes
 * memory or cross-conversation state.
 */
export class NewsroomEvidenceLedger {
	private items: EvidenceObject[] = [];

	add(items: EvidenceObject[]): void {
		if (!items.length) return;
		this.items = dedupeEvidence([...this.items, ...items]);
	}

	replace(items: EvidenceObject[]): void {
		this.items = dedupeEvidence(items);
	}

	markRejected(items: EvidenceObject[], reason: string): void {
		this.add(
			items.map((item) => ({
				...item,
				ledger_status: 'rejected' as const,
				temporal_scope: 'discovery' as const,
				rejection_reason: item.rejection_reason || reason
			}))
		);
	}

	all(): EvidenceObject[] {
		return [...this.items];
	}

	accepted(): EvidenceObject[] {
		return this.items.filter((item) => item.ledger_status !== 'rejected' && isUsableEvidence(item));
	}

	discovery(): EvidenceObject[] {
		return this.items.filter((item) => item.ledger_status === 'rejected' || item.temporal_scope === 'discovery');
	}

	usableCount(): number {
		return this.accepted().length;
	}

	size(): number {
		return this.items.length;
	}
}
