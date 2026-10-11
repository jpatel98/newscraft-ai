<script lang="ts">
	import type { CitationRecord } from '@newscraft/shared';
	import Copy from 'lucide-svelte/icons/copy';
	import RefreshCw from 'lucide-svelte/icons/refresh-cw';
	import X from 'lucide-svelte/icons/x';
	import EvidencePreview from './EvidencePreview.svelte';
	import {
		groupLedgerClaims,
		ledgerBrief,
		type StoryLedgerClaimView
	} from '$lib/utils/story-ledger-view';

	interface Props {
		claims: StoryLedgerClaimView[];
		/** Citation map for the thread, keyed by citation number. */
		citations?: CitationRecord[];
		loading?: boolean;
		error?: string | null;
		onRefresh?: () => void;
		onClose: () => void;
	}

	let { claims, citations = [], loading = false, error = null, onRefresh, onClose }: Props = $props();
	let openChecksOnly = $state(false);
	let copyState = $state<'idle' | 'success' | 'error'>('idle');
	let copyTimer: ReturnType<typeof setTimeout> | null = null;
	let selectedEvidence = $state<{ citation: CitationRecord; trigger: HTMLElement } | null>(null);

	const groups = $derived(groupLedgerClaims(claims, { openChecksOnly }));
	const openCheckCount = $derived(claims.filter((claim) => claim.needs_check).length);
	const citationByNumber = $derived(
		new Map(citations.map((citation) => [citation.citationNumber, citation]))
	);

	function setCopyState(state: 'success' | 'error') {
		copyState = state;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copyState = 'idle'), 1600);
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
			<div class="story-pane__eyebrow">Story ledger</div>
			<h2>Story</h2>
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
		{#if error}
			<p class="story-pane__empty" role="alert">{error}</p>
		{:else if !claims.length}
			<p class="story-pane__empty">No claims recorded yet. The ledger fills as answers are researched.</p>
		{:else if !groups.length}
			<p class="story-pane__empty">No claims need a check right now.</p>
		{:else}
			{#each groups as group (group.status)}
				<section class="story-group" aria-label={group.label}>
					<h3 class="story-group__title story-group__title--{group.status}">
						{group.label}<span>{group.claims.length}</span>
					</h3>
					<ul>
						{#each group.claims as claim (claim.id)}
							<li class="story-claim">
								<p class="story-claim__text">{claim.claim}</p>
								<div class="story-claim__meta">
									{#if claim.attributed_to}<span>per {claim.attributed_to}</span>{/if}
									{#if claim.date}<span>{claim.date}</span>{/if}
									{#each claim.citations as number (number)}
										{@const citation = citationByNumber.get(number)}
										{#if citation}
											<button
												type="button"
												class="story-claim__chip"
												aria-label={`Open source ${number}`}
												onclick={(event) =>
													(selectedEvidence = {
														citation,
														trigger: event.currentTarget as HTMLElement
													})}
											>[{number}]</button>
										{:else}
											<span class="story-claim__chip story-claim__chip--plain">[{number}]</span>
										{/if}
									{/each}
									{#if claim.needs_check}<span class="story-claim__check">needs check</span>{/if}
								</div>
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
	.story-group__title--alleged,
	.story-group__title--unverified { color: var(--cobalt-700); }
	.story-group__title--retracted { color: var(--fg-3); text-decoration: line-through; }
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
