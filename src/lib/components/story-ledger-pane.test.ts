import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupLedgerClaims, ledgerBrief, type StoryLedgerClaimView } from '$lib/utils/story-ledger-view';

function source(path: string): string {
	return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const claim = (overrides: Partial<StoryLedgerClaimView>): StoryLedgerClaimView => ({
	id: 'id',
	claim: 'A claim.',
	status: 'confirmed',
	attributed_to: '',
	citations: [],
	date: '',
	needs_check: false,
	updated_at: '2026-07-03T00:00:00.000Z',
	...overrides
});

describe('Story ledger pane', () => {
	it('groups by status, offers open checks, citation chips, empty state and copy-as-brief', () => {
		const pane = source('./StoryLedgerPane.svelte');
		expect(pane).toContain('data-testid="story-ledger-pane"');
		expect(pane).toContain('Open checks only');
		expect(pane).toContain('Copy as brief');
		expect(pane).toContain('needs check');
		expect(pane).toContain('No claims recorded yet. The ledger fills as answers are researched.');
		expect(pane).toContain('groupLedgerClaims(claims, { openChecksOnly })');
		expect(pane).toContain('<EvidencePreview');
		expect(pane).toContain('class="story-claim__chip story-claim__chip--plain"');
	});

	it('mounts from a Story header button beside the folder menu using the artifact slot layout', () => {
		const page = source('../../routes/c/[id]/+page.svelte');
		const storyIndex = page.indexOf('data-testid="story-ledger-button"');
		const menuIndex = page.indexOf('aria-label="Move to folder"');
		expect(storyIndex).toBeGreaterThan(0);
		expect(menuIndex).toBeGreaterThan(storyIndex);
		expect(page).toContain("{' to check'}</span></span>{/if}</button>");
		expect(page).toContain("import StoryLedgerPane from '$lib/components/StoryLedgerPane.svelte'");
		expect(page).toContain('<StoryLedgerPane');
		expect(page).toContain('artifact-slot artifact-slot--{artifactMode}');
		expect(page).toContain('/ledger`');
		expect(page).toContain('conversationId === activeConversationId) void refreshStoryLedger()');
		expect(page).toContain('stripLedgerForDisplay(asstText)');
	});

	it('hides the machine block everywhere the answer is persisted and replayed', () => {
		const runs = source('../server/db/hermes-runs.ts');
		expect(runs).toContain('stripLedgerFromAnswerEvent(dataJson)');
		expect(runs).toContain('upsertStoryClaims(conversationId, messageId, claims)');
		expect(source('../server/hermes-subscription.ts')).toContain('stripLedgerForDisplay(snapshot.answerText)');
	});
});

describe('ledger view helpers', () => {
	it('orders groups confirmed to retracted, drops empty ones and filters open checks', () => {
		const claims = [
			claim({ id: '1', status: 'retracted' }),
			claim({ id: '2', status: 'confirmed' }),
			claim({ id: '3', status: 'alleged', needs_check: true })
		];
		expect(groupLedgerClaims(claims).map((group) => group.status)).toEqual(['confirmed', 'alleged', 'retracted']);
		expect(groupLedgerClaims(claims, { openChecksOnly: true }).map((group) => group.status)).toEqual(['alleged']);
	});

	it('writes a plain-text brief grouped by status', () => {
		const brief = ledgerBrief([
			claim({ claim: 'Three soldiers were hurt.', attributed_to: 'DND', date: '2026-07-02', citations: [3, 5] }),
			claim({ claim: 'Driver was speeding.', status: 'alleged', attributed_to: 'police', needs_check: true })
		]);
		expect(brief).toBe(
			'STORY LEDGER\n\nCONFIRMED\n- Three soldiers were hurt. (per DND, 2026-07-02) [3][5]\n\nALLEGED\n- Driver was speeding. (per police) NEEDS CHECK\n'
		);
		expect(ledgerBrief([])).toBe('');
	});
});
