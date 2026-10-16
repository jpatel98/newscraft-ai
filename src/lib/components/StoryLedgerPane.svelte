<script lang="ts">
	import type { CitationRecord } from '@newscraft/shared';
	import Copy from 'lucide-svelte/icons/copy';
	import RefreshCw from 'lucide-svelte/icons/refresh-cw';
	import X from 'lucide-svelte/icons/x';
	import EvidencePreview from './EvidencePreview.svelte';
	import { LEDGER_STATUSES, type LedgerStatus } from '$lib/utils/story-ledger';
	import {
		groupLedgerClaims,
		LEDGER_STATUS_LABELS,
		ledgerBrief,
		type StoryClaimReviewInput,
		type StoryLedgerClaimView
	} from '$lib/utils/story-ledger-view';

	interface Props {
		claims: StoryLedgerClaimView[];
		/** Title of the chat these claims belong to; the ledger is per chat. */
		title?: string;
		/** Citation map for the thread, keyed by citation number. */
		citations?: CitationRecord[];
		loading?: boolean;
		error?: string | null;
		onRefresh?: () => void;
		/** Saves a person's call on one claim; rejects when the save failed. */
		onReview?: (claimId: string, review: StoryClaimReviewInput) => Promise<void>;
		onClose: () => void;
		/** Phone layout: a bottom sheet that drags between half and full height,
		 * with swipe on a claim to mark it checked or flag it. */
		sheet?: boolean;
	}

	let { claims, title = '', citations = [], loading = false, error = null, onRefresh, onReview, onClose, sheet = false }: Props = $props();
	let savingId = $state<string | null>(null);
	let reviewError = $state<{ id: string; message: string } | null>(null);
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

	// ---- Bottom sheet (phone) ----
	const SWIPE_COMMIT_PX = 90;
	let pane: HTMLElement | undefined = $state();
	let snap = $state<'half' | 'full'>('half');
	let dragHeight = $state<number | null>(null);
	let drag: { pointerId: number; startY: number; startHeight: number; moved: boolean } | null = null;

	function fullHeight(): number {
		const viewport = window.visualViewport?.height ?? window.innerHeight;
		return Math.max(200, viewport - 24);
	}

	function onGrabDown(event: PointerEvent) {
		if (!sheet || !pane) return;
		drag = {
			pointerId: event.pointerId,
			startY: event.clientY,
			startHeight: pane.getBoundingClientRect().height,
			moved: false
		};
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onGrabMove(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		const dy = event.clientY - drag.startY;
		if (Math.abs(dy) > 4) drag.moved = true;
		if (drag.moved) dragHeight = Math.min(fullHeight(), Math.max(60, drag.startHeight - dy));
	}

	function onGrabUp(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		const { moved, startHeight } = drag;
		drag = null;
		const height = dragHeight;
		dragHeight = null;
		if (!moved || height === null) {
			snap = snap === 'half' ? 'full' : 'half';
			return;
		}
		const full = fullHeight();
		const half = full * 0.6;
		if (height < Math.min(half, startHeight) * 0.65) onClose();
		else snap = height > (half + full) / 2 ? 'full' : 'half';
	}

	let swipe = $state<{ id: string; dx: number } | null>(null);
	let swipeStart: { id: string; pointerId: number; x: number; y: number; active: boolean } | null = null;

	function onClaimDown(event: PointerEvent, id: string) {
		if (!sheet || !onReview || savingId || (event.target as HTMLElement).closest('button, select, a')) return;
		swipeStart = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
	}

	function onClaimMove(event: PointerEvent) {
		if (!swipeStart || event.pointerId !== swipeStart.pointerId) return;
		const dx = event.clientX - swipeStart.x;
		const dy = event.clientY - swipeStart.y;
		if (!swipeStart.active) {
			if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
				swipeStart = null;
				return;
			}
			if (Math.abs(dx) < 10) return;
			swipeStart.active = true;
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		}
		swipe = { id: swipeStart.id, dx: Math.max(-140, Math.min(140, dx)) };
	}

	function onClaimUp(event: PointerEvent, claim: StoryLedgerClaimView) {
		if (!swipeStart || event.pointerId !== swipeStart.pointerId) return;
		const dx = swipe?.id === claim.id ? swipe.dx : 0;
		swipeStart = null;
		swipe = null;
		if (dx >= SWIPE_COMMIT_PX && claim.needs_check) void review(claim.id, { needs_check: false });
		else if (dx <= -SWIPE_COMMIT_PX && !claim.needs_check) void review(claim.id, { needs_check: true });
	}

	function cancelSwipe() {
		swipeStart = null;
		swipe = null;
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

<aside
	bind:this={pane}
	class="story-pane"
	class:story-pane--sheet={sheet}
	class:story-pane--dragging={dragHeight !== null}
	data-testid="story-ledger-pane"
	data-snap={sheet ? snap : undefined}
	style={dragHeight !== null ? `height: ${dragHeight}px` : undefined}
	aria-label="Story ledger"
>
	{#if sheet}
		<button
			type="button"
			class="story-pane__grab"
			aria-label={snap === 'half' ? 'Expand story ledger' : 'Shrink story ledger'}
			onclick={(event) => event.preventDefault()}
			onpointerdown={onGrabDown}
			onpointermove={onGrabMove}
			onpointerup={onGrabUp}
			onpointercancel={() => {
				drag = null;
				dragHeight = null;
			}}
			onkeydown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					snap = snap === 'half' ? 'full' : 'half';
				}
			}}
		><span aria-hidden="true"></span></button>
	{/if}
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
		{#if error}
			<p class="story-pane__empty" role="alert">{error}</p>
		{:else if !claims.length}
			<p class="story-pane__empty">No facts recorded in this chat yet. The ledger fills as answers here are researched.</p>
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
							{@const dx = swipe?.id === claim.id ? swipe.dx : 0}
							<li class="story-claim-row">
								{#if sheet && onReview && dx !== 0}
									<span
										class="story-claim__swipe-hint story-claim__swipe-hint--{dx > 0 ? 'check' : 'flag'}"
										class:story-claim__swipe-hint--ready={Math.abs(dx) >= SWIPE_COMMIT_PX &&
											(dx > 0 ? claim.needs_check : !claim.needs_check)}
										aria-hidden="true"
									>{dx > 0
											? claim.needs_check ? 'Mark checked' : 'Already checked'
											: claim.needs_check ? 'Already flagged' : 'Flag for check'}</span>
								{/if}
								<div
									class="story-claim"
									class:story-claim--swiping={dx !== 0}
									style={dx !== 0 ? `transform: translateX(${dx}px)` : undefined}
									onpointerdown={(event) => onClaimDown(event, claim.id)}
									onpointermove={onClaimMove}
									onpointerup={(event) => onClaimUp(event, claim)}
									onpointercancel={cancelSwipe}
									role="group"
									aria-label={claim.claim}
								>
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
	.story-group__title--alleged,
	.story-group__title--unverified { color: var(--cobalt-700); }
	.story-group__title--retracted { color: var(--fg-3); text-decoration: line-through; }
	.story-claim-row { position: relative; }
	.story-claim {
		position: relative;
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
	/* ---- Phone bottom sheet ---- */
	.story-pane--sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 61;
		height: calc(var(--visual-vh, 100dvh) * 0.6);
		grid-template-rows: auto auto auto minmax(0, 1fr) auto;
		border: 1px solid var(--border-default);
		border-bottom: 0;
		border-radius: 14px 14px 0 0;
		box-shadow: 0 -8px 28px rgb(15 23 42 / 14%);
		transition: height 180ms var(--ease-std, ease);
	}
	.story-pane--sheet[data-snap='full'] {
		height: calc(var(--visual-vh, 100dvh) - 24px);
	}
	.story-pane--dragging { transition: none; }
	.story-pane__grab {
		display: flex;
		justify-content: center;
		width: 100%;
		height: 28px;
		padding: 10px 0 0;
		border: 0;
		background: transparent;
		cursor: grab;
		touch-action: none;
	}
	.story-pane__grab span {
		width: 40px;
		height: 5px;
		border-radius: 3px;
		background: var(--border-strong, var(--fg-3));
	}
	.story-pane__grab:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
	.story-pane--sheet .story-pane__header { padding-top: 4px; }
	.story-pane--sheet .story-pane__icon { width: 44px; height: 44px; flex-basis: 44px; }
	.story-pane--sheet .story-pane__toggle { min-height: 44px; }
	.story-pane--sheet .story-claim { touch-action: pan-y; transition: transform 160ms var(--ease-std, ease); }
	.story-pane--sheet .story-claim--swiping { transition: none; }
	.story-pane--sheet .story-claim__action,
	.story-pane--sheet .story-claim__status { min-height: 40px; font-size: 12px; }
	.story-pane--sheet .story-claim__chip { min-height: 32px; min-width: 36px; }
	.story-pane--sheet .story-pane__button { min-height: 44px; }
	.story-claim__swipe-hint {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		padding: 0 16px;
		border-radius: var(--radius-1);
		background: var(--bg-raised);
		color: var(--fg-3);
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 650;
	}
	.story-claim__swipe-hint--flag { justify-content: flex-end; }
	.story-claim__swipe-hint--ready.story-claim__swipe-hint--check { background: var(--cobalt-600); color: #fff; }
	.story-claim__swipe-hint--ready.story-claim__swipe-hint--flag { background: var(--cobalt-100); color: var(--cobalt-800); }
	.story-pane__icon:focus-visible,
	.story-pane__button:focus-visible,
	.story-claim__chip:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
</style>
