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
		expect(pane).toContain('Changed since you last looked');
		expect(pane).toContain('Say: “{attribution.phrase}”');
		expect(pane).toContain('Copy as brief');
		expect(pane).toContain('needs check');
		expect(pane).toContain('No facts recorded in this chat yet. The ledger fills as answers here are researched.');
		expect(pane).toContain('Story ledger · this chat');
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
		expect(page).toContain('title={conversationTitle}');
		expect(page).toContain('artifact-slot artifact-slot--{artifactMode}');
		expect(page).toContain('/ledger`');
		expect(page).toContain('conversationId === activeConversationId) void refreshStoryLedger()');
		expect(page).toContain('stripLedgerForDisplay(asstText)');
	});

	it('hides the machine block everywhere the answer is persisted and replayed', () => {
		const runs = source('../server/db/hermes-runs.ts');
		expect(runs).toContain('stripLedgerFromAnswerEvent(dataJson)');
		expect(runs).toContain('upsertStoryClaims(conversationId, messageId, claims, Date.now(), workerClaimJudge, citationSources(citations))');
		expect(source('../server/hermes-subscription.ts')).toContain('stripLedgerForDisplay(snapshot.answerText)');
	});
});

describe('ledger view helpers', () => {
	it('groups by air readiness: open checks, safe, attribute carefully, hold; drops empty ones', () => {
		const claims = [
			claim({ id: '1', status: 'retracted' }),
			claim({ id: '2', status: 'confirmed' }),
			claim({ id: '3', status: 'alleged', needs_check: true }),
			claim({ id: '4', status: 'reported' }),
			claim({ id: '5', status: 'unverified' })
		];
		expect(groupLedgerClaims(claims).map((group) => [group.bucket, group.claims.map((c) => c.id)])).toEqual([
			['check', ['3']],
			['safe', ['2']],
			['careful', ['4']],
			['hold', ['1', '5']]
		]);
		expect(groupLedgerClaims(claims, { openChecksOnly: true }).map((group) => group.bucket)).toEqual(['check']);
	});

	it('writes a plain-text brief with the phrase to say for each claim that needs attribution', () => {
		const brief = ledgerBrief([
			claim({ claim: 'Three soldiers were hurt.', attributed_to: 'DND', date: '2026-07-02', citations: [3, 5] }),
			claim({ claim: 'Driver was speeding.', status: 'alleged', attributed_to: 'police', needs_check: true, check_reason: 'contradicted' }),
			claim({ claim: 'The plant will close.', status: 'reported', sources: [{ n: 1, url: 'https://www.cbc.ca/1', host: 'cbc.ca', tier: 'wire_major', date: '' }] })
		]);
		expect(brief).toBe(
			'STORY LEDGER\n\nOPEN CHECKS\n- Driver was speeding. (alleged)\n  Say: "police allege"\n  NEEDS CHECK: sources disagree\n\n' +
				'SAFE TO AIR\n- Three soldiers were hurt. (confirmed, 2026-07-02) [3][5]\n\n' +
				'ATTRIBUTE CAREFULLY\n- The plant will close. (reported)\n  Say: "according to CBC News"\n'
		);
		expect(ledgerBrief([])).toBe('');
	});
});
