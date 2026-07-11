<script lang="ts">
	import type { CitationRecord } from '@newscraft/shared';
	import { onDestroy, onMount } from 'svelte';
	import ExternalLink from 'lucide-svelte/icons/external-link';
	import X from 'lucide-svelte/icons/x';
	import { citationSourceTypeLabel, publicationDateLabel } from './journalist-ui';

	interface Props {
		citation: CitationRecord;
		returnFocus?: HTMLElement | null;
		onClose: () => void;
	}

	let { citation, returnFocus = null, onClose }: Props = $props();
	let dialog: HTMLElement | undefined = $state();
	let closeButton: HTMLButtonElement | undefined = $state();
	let previousFocus: HTMLElement | null = null;

	const titleId = $derived(`evidence-title-${citation.citationNumber}`);
	const excerptId = $derived(`evidence-excerpt-${citation.citationNumber}`);

	onMount(() => {
		previousFocus = returnFocus ?? (document.activeElement as HTMLElement | null);
		requestAnimationFrame(() => closeButton?.focus());
	});

	onDestroy(() => {
		const target = previousFocus;
		queueMicrotask(() => target?.focus());
	});

	function focusableElements(): HTMLElement[] {
		if (!dialog) return [];
		return Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
			)
		).filter((element) => element.getClientRects().length > 0);
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== 'Tab') return;
		const focusable = focusableElements();
		if (focusable.length === 0) {
			event.preventDefault();
			dialog?.focus();
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="evidence-backdrop" data-testid="evidence-backdrop">
	<button
		type="button"
		class="evidence-backdrop__dismiss"
		aria-label="Dismiss evidence preview"
		aria-hidden="true"
		tabindex="-1"
		onclick={onClose}
	></button>
	<div
		bind:this={dialog}
		class="evidence-preview"
		data-testid="evidence-preview"
		role="dialog"
		aria-modal="true"
		aria-labelledby={titleId}
		aria-describedby={excerptId}
		tabindex="-1"
	>
		<div class="evidence-preview__handle" aria-hidden="true"></div>
		<header class="evidence-preview__header">
			<div class="evidence-preview__heading">
				<span class="evidence-preview__number">Citation {citation.citationNumber}</span>
				<h2 id={titleId}>{citation.title}</h2>
			</div>
			<button
				bind:this={closeButton}
				type="button"
				class="evidence-preview__close"
				onclick={onClose}
				aria-label="Close evidence preview"
				title="Close evidence preview"
			>
				<X size="16" strokeWidth={1.8} aria-hidden="true" />
			</button>
		</header>

		<div class="evidence-preview__meta">
			<span>{publicationDateLabel(citation.publicationDate)}</span>
			<span aria-hidden="true">·</span>
			<span>{citationSourceTypeLabel(citation.sourceType)}</span>
			{#if citation.documentPage}
				<span aria-hidden="true">·</span>
				<span>Page {citation.documentPage}</span>
			{/if}
		</div>

		<blockquote id={excerptId} class="evidence-preview__excerpt">
			{citation.supportingExcerpt || 'No supporting excerpt is available.'}
		</blockquote>

		<footer class="evidence-preview__footer">
			<span class="evidence-preview__domain">{citation.domain}</span>
			<a
				class="evidence-preview__link"
				href={citation.url}
				target="_blank"
				rel="noopener noreferrer"
			>
				<span>Open original</span>
				<ExternalLink size="13" strokeWidth={1.8} aria-hidden="true" />
			</a>
		</footer>
	</div>
</div>

<style>
	.evidence-backdrop {
		position: fixed;
		inset: 0;
		z-index: 90;
		display: grid;
		place-items: center;
		padding: 20px;
		background: color-mix(in srgb, var(--ink-900) 30%, transparent);
	}

	.evidence-preview {
		position: relative;
		width: min(520px, 100%);
		max-height: min(680px, calc(100dvh - 40px));
		overflow-y: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		box-shadow: var(--shadow-3);
		padding: 18px;
		color: var(--fg-1);
	}

	.evidence-backdrop__dismiss {
		position: absolute;
		inset: 0;
		border: 0;
		background: transparent;
		padding: 0;
		cursor: default;
	}

	.evidence-preview:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus), var(--shadow-3);
	}

	.evidence-preview__handle {
		display: none;
	}

	.evidence-preview__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.evidence-preview__heading {
		min-width: 0;
	}

	.evidence-preview__number {
		display: block;
		margin-bottom: 5px;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 650;
		color: var(--accent-fg);
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.evidence-preview h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 18px;
		line-height: 1.3;
		letter-spacing: 0;
		overflow-wrap: anywhere;
	}

	.evidence-preview__close {
		width: 32px;
		height: 32px;
		flex: 0 0 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-1);
		background: transparent;
		color: var(--fg-2);
		cursor: pointer;
	}

	.evidence-preview__close:hover {
		border-color: var(--border-default);
		background: var(--bg-raised);
		color: var(--fg-1);
	}

	.evidence-preview__close:focus-visible,
	.evidence-preview__link:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}

	.evidence-preview__meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 5px;
		margin-top: 10px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		letter-spacing: 0;
	}

	.evidence-preview__excerpt {
		margin: 18px 0;
		padding: 13px 14px;
		border-left: 2px solid var(--cobalt-500);
		background: var(--bg-raised);
		color: var(--fg-1);
		font-size: 14px;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}

	.evidence-preview__footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-top: 13px;
		border-top: 1px solid var(--border-soft);
	}

	.evidence-preview__domain {
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.evidence-preview__link {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		padding: 0 10px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		background: var(--bg-surface);
		color: var(--accent-fg);
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0;
		text-decoration: none;
	}

	.evidence-preview__link:hover {
		background: var(--bg-raised);
		color: var(--accent-hover);
	}

	@media (max-width: 640px) {
		.evidence-backdrop {
			place-items: end stretch;
			padding: 0;
		}

		.evidence-preview {
			width: 100%;
			max-height: min(78dvh, 680px);
			border-right: 0;
			border-bottom: 0;
			border-left: 0;
			border-radius: var(--radius-2) var(--radius-2) 0 0;
			padding: 10px 16px max(18px, env(safe-area-inset-bottom));
		}

		.evidence-preview__handle {
			display: block;
			width: 36px;
			height: 3px;
			margin: 0 auto 12px;
			border-radius: var(--radius-pill);
			background: var(--border-strong);
		}

		.evidence-preview__excerpt {
			margin: 16px 0;
		}
	}
</style>
