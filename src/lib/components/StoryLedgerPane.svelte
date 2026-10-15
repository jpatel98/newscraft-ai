<script lang="ts">
	import type { CitationRecord } from '@newscraft/shared';
	import Copy from 'lucide-svelte/icons/copy';
	import RefreshCw from 'lucide-svelte/icons/refresh-cw';
	import X from 'lucide-svelte/icons/x';
	import EvidencePreview from './EvidencePreview.svelte';
	import { attributionFor, publisherName } from '$lib/utils/claim-air';
	import { LEDGER_STATUSES, type LedgerStatus } from '$lib/utils/story-ledger';
	import {
		CHECK_REASON,
		groupLedgerClaims,
		LEDGER_STATUS_LABELS,
		ledgerBrief,
		ledgerChangeLines,
		type StoryClaimReviewInput,
		type StoryLedgerChangeView,
		type StoryLedgerClaimView,
		type StoryLedgerSourceView
	} from '$lib/utils/story-ledger-view';

	interface Props {
		claims: StoryLedgerClaimView[];
		/** Title of the chat these claims belong to; the ledger is per chat. */
		title?: string;
		/** Citation map for the thread, keyed by citation number (fallback for claims without resolved sources). */
		citations?: CitationRecord[];
		/** Ledger events since the person last looked. */
		changes?: StoryLedgerChangeView[];
		loading?: boolean;
		error?: string | null;
		onRefresh?: () => void;
		/** Saves a person's call on one claim; rejects when the save failed. */
		onReview?: (claimId: string, review: StoryClaimReviewInput) => Promise<void>;
		/** The person has seen the listed changes. */
		onMarkSeen?: () => void;
		onClose: () => void;
	}

	let {
		claims,
		title = '',
		citations = [],
		changes = [],
		loading = false,
		error = null,
		onRefresh,
		onReview,
		onMarkSeen,
		onClose
	}: Props = $props();
	let savingId = $state<string | null>(null);
	let reviewError = $state<{ id: string; message: string } | null>(null);
	let openChecksOnly = $state(false);
	let copyState = $state<'idle' | 'success' | 'error'>('idle');
	let copyTimer: ReturnType<typeof setTimeout> | null = null;
	let selectedEvidence = $state<{ citation: CitationRecord; trigger: HTMLElement } | null>(null);

	const groups = $derived(groupLedgerClaims(claims, { openChecksOnly }));
	const openCheckCount = $derived(claims.filter((claim) => claim.needs_check).length);
	const changeLines = $derived(ledgerChangeLines(changes, claims));
	const citationByNumber = $derived(
		new Map(citations.map((citation) => [citation.citationNumber, citation]))
	);

	/** A claim's chips: its own resolved sources, else the thread's citation map. */
	function chipsFor(claim: StoryLedgerClaimView): { n: number; label: string; citation: CitationRecord | null }[] {
		if (claim.sources?.length) {
			return claim.sources.map((source) => ({ n: source.n, label: publisherName(source.host), citation: asCitation(source) }));
		}
		return claim.citations.map((n) => ({ n, label: '', citation: citationByNumber.get(n) ?? null }));
	}

	function asCitation(source: StoryLedgerSourceView): CitationRecord {
		const known = citations.find((citation) => citation.url === source.url);
		return (
			known ?? {
				citationNumber: source.n,
				title: source.host,
				url: source.url,
				domain: source.host,
				publicationDate: source.date || null,
				sourceType: source.tier === 'official' ? 'official' : source.tier === 'aggregator' ? 'aggregator' : 'news_report',
				supportingExcerpt: ''
			}
		);
	}

	function setCopyState(state: 'success' | 'error') {
		copyState = state;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copyState = 'idle'), 1600);
	}

	async function review(claimId: string, input: StoryClaimReviewInput) {
		if (!onReview || savingId) return;
		savingId = claimId;
		reviewError = null;
		try {
			await onReview(claimId, input);
		} catch {
			reviewError = { id: claimId, message: "Couldn't save that. Try again." };
		} finally {
			savingId = null;
		}
	}

	function reviewedWhen(iso: string | null | undefined): string {
		if (!iso) return '';
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return '';
		return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}

	async function copyBrief() {
		try {
			if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
			await navigator.clipboard.writeText(ledgerBrief(claims));
			setCopyState('success');
		} catch {
			setCopyState('error');
		}
	}
</script>

<aside class="story-pane" data-testid="story-ledger-pane" aria-label="Story ledger">
	<header class="story-pane__header">
		<div>
			<div class="story-pane__eyebrow">Story ledger · this chat</div>
			<h2 title={title || undefined}>{title || 'Untitled chat'}</h2>
		</div>
		<div class="story-pane__header-actions">
			{#if onRefresh}
				<button
					type="button"
					class="story-pane__icon"
					onclick={onRefresh}
					disabled={loading}
					aria-label="Refresh story ledger"
				>
					<RefreshCw size="14" strokeWidth={1.8} aria-hidden="true" />
				</button>
			{/if}
			<button type="button" class="story-pane__icon" onclick={onClose} aria-label="Close story pane">
				<X size="16" strokeWidth={1.8} aria-hidden="true" />
			</button>
		</div>
	</header>

	<div class="story-pane__toolbar">
		<label class="story-pane__toggle">
			<input type="checkbox" bind:checked={openChecksOnly} />
			<span>Open checks only</span>
			<span class="story-pane__count">{openCheckCount}</span>
		</label>
		<span class="story-pane__status" role="status">
			{#if loading}Updating…{:else}{claims.length} claim{claims.length === 1 ? '' : 's'}{/if}
		</span>
	</div>

	<div class="story-pane__body">
		{#if changeLines.length && !openChecksOnly}
			<section class="story-changes" data-testid="story-ledger-changes" aria-label="Changed since you last looked">
				<div class="story-changes__head">
					<h3>Changed since you last looked<span>{changeLines.length}</span></h3>
					{#if onMarkSeen}
						<button type="button" class="story-claim__action" onclick={onMarkSeen}>Mark as seen</button>
					{/if}
				</div>
				<ul>
					{#each changeLines as line, index (`${line.claimId}-${index}`)}
						<li><span class="story-changes__what">{line.what}</span> {line.claim}</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if error}
			<p class="story-pane__empty" role="alert">{error}</p>
		{:else if !claims.length}
			<p class="story-pane__empty">No facts recorded in this chat yet. The ledger fills as answers here are researched.</p>
		{:else if !groups.length}
			<p class="story-pane__empty">No claims need a check right now.</p>
		{:else}
			{#each groups as group (group.bucket)}
				<section class="story-group" aria-label={group.label} data-bucket={group.bucket}>
					<h3 class="story-group__title story-group__title--{group.bucket}">
						{group.label}<span>{group.claims.length}</span>
					</h3>
					<ul>
						{#each group.claims as claim (claim.id)}
							{@const attribution = attributionFor(claim)}
							<li class="story-claim" data-testid="story-claim">
								<p class="story-claim__text">{claim.claim}</p>
								{#if attribution.required && attribution.phrase && claim.status !== 'unverified' && claim.status !== 'retracted'}
									<p class="story-claim__say" data-testid="story-claim-say">Say: “{attribution.phrase}”</p>
								{/if}
								<div class="story-claim__meta">
									<span class="story-claim__status-tag story-claim__status-tag--{claim.status}">{LEDGER_STATUS_LABELS[claim.status]}</span>
									{#if claim.suggested_status && claim.suggested_status !== claim.status && !claim.reviewed_by}
										<span title="What the research said before the sources were weighed">model said {LEDGER_STATUS_LABELS[claim.suggested_status].toLowerCase()}</span>
									{/if}
									{#if claim.attributed_to}<span>per {claim.attributed_to}</span>{/if}
									{#if claim.date}<span>{claim.date}</span>{/if}
									{#each chipsFor(claim) as chip, index (`${chip.n}-${index}`)}
										{#if chip.citation}
											{@const citation = chip.citation}
											<button
												type="button"
												class="story-claim__chip"
												aria-label={`Open source ${chip.n}`}
												onclick={(event) =>
													(selectedEvidence = {
														citation,
														trigger: event.currentTarget as HTMLElement
													})}
											>[{chip.n}]{chip.label ? ` ${chip.label}` : ''}</button>
										{:else}
											<span class="story-claim__chip story-claim__chip--plain">[{chip.n}]</span>
										{/if}
									{/each}
									{#if claim.needs_check}<span class="story-claim__check">needs check{claim.check_reason && CHECK_REASON[claim.check_reason] ? `: ${CHECK_REASON[claim.check_reason]}` : ''}</span>{/if}
								</div>
								{#if claim.reviewed_by}
									<p class="story-claim__reviewed">
										Checked by {claim.reviewed_by}{#if reviewedWhen(claim.reviewed_at)}, {reviewedWhen(claim.reviewed_at)}{/if}
									</p>
								{/if}
								{#if onReview}
									<div class="story-claim__actions">
										<button
											type="button"
											class="story-claim__action"
											disabled={savingId !== null}
											onclick={() => review(claim.id, { needs_check: !claim.needs_check })}
										>{claim.needs_check ? 'Mark checked' : 'Flag for check'}</button>
										<select
											class="story-claim__status"
											aria-label="Change status"
											value={claim.status}
											disabled={savingId !== null}
											onchange={(event) => {
												const next = (event.currentTarget as HTMLSelectElement).value as LedgerStatus;
												if (next !== claim.status) void review(claim.id, { status: next });
											}}
										>
											{#each LEDGER_STATUSES as status (status)}
												<option value={status}>{LEDGER_STATUS_LABELS[status]}</option>
											{/each}
										</select>
										{#if savingId === claim.id}<span class="story-claim__saving" role="status">Saving…</span>{/if}
									</div>
									{#if reviewError?.id === claim.id}
										<p class="story-claim__error" role="alert">{reviewError.message}</p>
									{/if}
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		{/if}
	</div>

	<footer class="story-pane__footer">
		<button type="button" class="story-pane__button" onclick={copyBrief} disabled={!claims.length}>
			<Copy size="14" strokeWidth={1.7} aria-hidden="true" />
			<span aria-live="polite">
				{copyState === 'success' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy as brief'}
			</span>
		</button>
	</footer>
</aside>

{#if selectedEvidence}
	<EvidencePreview
		citation={selectedEvidence.citation}
		returnFocus={selectedEvidence.trigger}
		onClose={() => (selectedEvidence = null)}
	/>
{/if}

<style>
	.story-pane {
		flex: 1 1 auto;
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		min-height: 0;
		overflow-wrap: anywhere;
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr) auto;
		border-left: 1px solid var(--border-default);
		background: var(--bg-surface);
		color: var(--fg-1);
	}
	.story-pane__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 14px;
		padding: 16px 18px 12px;
	}

	.story-pane__header > div:first-child {
		min-width: 0;
	}
	.story-pane__header-actions { display: flex; gap: 6px; }
	.story-pane__eyebrow {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 650;
		color: var(--accent-fg);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.story-pane h2 {
		margin: 3px 0 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-display);
		font-size: 18px;
		line-height: 1.2;
		letter-spacing: 0;
	}
	.story-pane__icon {
		width: 32px;
		height: 32px;
		flex: 0 0 32px;
		display: grid;
		place-items: center;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-1);
		background: transparent;
		color: var(--fg-2);
		cursor: pointer;
	}
	.story-pane__toolbar {
		min-height: 35px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 18px;
		border-block: 1px solid var(--border-soft);
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
	}
	.story-pane__toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
	.story-pane__count {
		min-width: 16px;
		padding: 0 5px;
		border-radius: 8px;
		background: var(--bg-raised);
		text-align: center;
	}
	.story-pane__body { overflow-y: auto; padding: 14px 18px; font-size: 14px; line-height: 1.5; }
	.story-pane__empty { margin: 0; color: var(--fg-3); font-size: 13px; }
	.story-group + .story-group { margin-top: 18px; }
	.story-group ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
	.story-group__title {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 8px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-2);
	}
	.story-group__title span { color: var(--fg-3); font-weight: 500; }
	.story-group__title--check,
	.story-group__title--careful { color: var(--cobalt-700); }
	.story-group__title--hold { color: var(--fg-3); }
	.story-claim__say {
		margin: 4px 0 0;
		font-size: 12.5px;
		color: var(--cobalt-700);
	}
	.story-claim__status-tag { font-weight: 650; color: var(--fg-2); }
	.story-claim__status-tag--retracted { text-decoration: line-through; }
	.story-changes {
		margin-bottom: 18px;
		padding: 10px 12px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		background: var(--bg-raised);
		font-size: 12.5px;
	}
	.story-changes__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.story-changes h3 {
		display: flex;
		gap: 8px;
		margin: 0;
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-2);
	}
	.story-changes h3 span { color: var(--fg-3); font-weight: 500; }
	.story-changes ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
	.story-changes__what { font-family: var(--font-mono); font-size: 10.5px; font-weight: 650; color: var(--accent-fg); }
	.story-claim {
		padding: 10px 12px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-1);
		background: var(--bg-page);
	}
	.story-claim__text { margin: 0; }
	.story-claim__meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		margin-top: 6px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
	}
	.story-claim__chip {
		padding: 1px 5px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-1);
		background: var(--bg-surface);
		color: var(--accent-fg);
		font: inherit;
		cursor: pointer;
	}
	.story-claim__chip--plain { color: var(--fg-3); cursor: default; }
	.story-claim__check {
		padding: 1px 6px;
		border-radius: var(--radius-1);
		background: color-mix(in srgb, var(--cobalt-100) 55%, var(--bg-surface));
		color: var(--cobalt-700);
		font-weight: 650;
	}
	.story-claim__reviewed {
		margin: 6px 0 0;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-2);
	}
	.story-claim__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
	}
	.story-claim__action,
	.story-claim__status {
		min-height: 28px;
		padding: 0 8px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		background: var(--bg-surface);
		color: var(--fg-2);
		font-family: var(--font-mono);
		font-size: 10.5px;
		cursor: pointer;
	}
	.story-claim__action:hover:not(:disabled),
	.story-claim__status:hover:not(:disabled) { background: var(--bg-raised); color: var(--fg-1); }
	.story-claim__action:disabled,
	.story-claim__status:disabled { opacity: 0.5; cursor: default; }
	.story-claim__action:focus-visible,
	.story-claim__status:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
	.story-claim__saving { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); }
	.story-claim__error { margin: 6px 0 0; font-size: 12px; color: var(--danger-fg, var(--fg-1)); }
	.story-pane__footer {
		display: flex;
		gap: 8px;
		padding: 12px 18px calc(12px + env(safe-area-inset-bottom, 0px));
		border-top: 1px solid var(--border-default);
		background: var(--bg-page);
	}
	.story-pane__button {
		min-height: 34px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		background: var(--bg-surface);
		color: var(--fg-2);
		font-family: var(--font-mono);
		font-size: 10.5px;
		cursor: pointer;
	}
	.story-pane__button:disabled,
	.story-pane__icon:disabled { opacity: 0.5; cursor: default; }
	.story-pane__icon:hover:not(:disabled),
	.story-pane__button:hover:not(:disabled) { background: var(--bg-raised); color: var(--fg-1); }
	.story-pane__icon:focus-visible,
	.story-pane__button:focus-visible,
	.story-claim__chip:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
</style>
