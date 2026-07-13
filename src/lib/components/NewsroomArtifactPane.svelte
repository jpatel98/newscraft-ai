<script lang="ts">
	import type { CitationRecord } from '@newscraft/shared';
	import Check from 'lucide-svelte/icons/check';
	import Copy from 'lucide-svelte/icons/copy';
	import Download from 'lucide-svelte/icons/download';
	import X from 'lucide-svelte/icons/x';
	import EvidencePreview from './EvidencePreview.svelte';
	import Markdown from './Markdown.svelte';
	import { ANSWER_USE_ACTIONS, type AnswerUseAction } from './journalist-ui';

	export interface ArtifactDraft {
		action: AnswerUseAction;
		sourceMessageId: string;
		content: string;
		citations: CitationRecord[];
		status: 'generating' | 'ready' | 'error';
	}

	interface Props {
		draft: ArtifactDraft;
		disabled?: boolean;
		onSelect: (action: AnswerUseAction, sourceMessageId: string) => Promise<void> | void;
		onClose: () => void;
	}

	let { draft, disabled = false, onSelect, onClose }: Props = $props();
	let copyState = $state<'idle' | 'success' | 'error'>('idle');
	let copyTimer: ReturnType<typeof setTimeout> | null = null;
	let selectedEvidence = $state<{ citation: CitationRecord; trigger: HTMLElement } | null>(null);

	const title = $derived(
		ANSWER_USE_ACTIONS.find((candidate) => candidate.action === draft.action)?.label ?? 'Newsroom copy'
	);

	function setCopyState(state: 'success' | 'error') {
		copyState = state;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copyState = 'idle'), 1600);
	}

	async function copyArtifact() {
		try {
			if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
			await navigator.clipboard.writeText(draft.content);
			setCopyState('success');
		} catch {
			setCopyState('error');
		}
	}

	function downloadArtifact() {
		const blob = new Blob([draft.content], { type: 'text/markdown;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `${draft.action.replaceAll('_', '-')}.md`;
		link.click();
		URL.revokeObjectURL(url);
	}
</script>

<aside class="artifact-pane" data-testid="newsroom-artifact-pane" aria-label="Newsroom artifact">
	<header class="artifact-pane__header">
		<div>
			<div class="artifact-pane__eyebrow">Newsroom artifact</div>
			<h2>{title}</h2>
		</div>
		<button type="button" class="artifact-pane__icon" onclick={onClose} aria-label="Close artifact pane">
			<X size="16" strokeWidth={1.8} aria-hidden="true" />
		</button>
	</header>

	<div class="artifact-pane__formats" aria-label="Artifact format">
		{#each ANSWER_USE_ACTIONS as option (option.action)}
			<button
				type="button"
				class:artifact-pane__format--active={option.action === draft.action}
				class="artifact-pane__format"
				disabled={disabled || draft.status === 'generating'}
				onclick={() => onSelect(option.action, draft.sourceMessageId)}
				aria-pressed={option.action === draft.action}
			>
				{option.label}
			</button>
		{/each}
	</div>

	<div class="artifact-pane__status" role="status">
		{#if draft.status === 'generating'}
			<span class="artifact-pane__pulse" aria-hidden="true"></span>
			Drafting {title.toLowerCase()}
		{:else if draft.status === 'error'}
			The draft could not be completed. The source answer is unchanged.
		{:else}
			<Check size="13" strokeWidth={2} aria-hidden="true" />
			Ready · {draft.citations.length} citation{draft.citations.length === 1 ? '' : 's'}
		{/if}
	</div>

	<div class="artifact-pane__body" aria-live="polite">
		{#if draft.content}
			<Markdown
				content={draft.content}
				partial={draft.status === 'generating'}
				assistant
				citations={draft.citations}
				onCitationSelect={(citation, trigger) => (selectedEvidence = { citation, trigger })}
			/>
		{:else if draft.status === 'generating'}
			<div class="artifact-pane__skeleton" aria-hidden="true">
				<span></span><span></span><span></span>
			</div>
		{/if}
	</div>

	<footer class="artifact-pane__footer">
		<button
			type="button"
			class="artifact-pane__button"
			onclick={copyArtifact}
			disabled={!draft.content}
		>
			<Copy size="14" strokeWidth={1.7} aria-hidden="true" />
			<span aria-live="polite">
				{copyState === 'success' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy'}
			</span>
		</button>
		<button
			type="button"
			class="artifact-pane__button"
			onclick={downloadArtifact}
			disabled={!draft.content}
		>
			<Download size="14" strokeWidth={1.7} aria-hidden="true" />
			<span>Markdown</span>
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
	.artifact-pane {
		width: min(430px, 40vw);
		min-width: 340px;
		min-height: 0;
		display: grid;
		grid-template-rows: auto auto auto minmax(0, 1fr) auto;
		border-left: 1px solid var(--border-default);
		background: var(--bg-surface);
		color: var(--fg-1);
	}
	.artifact-pane__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 14px;
		padding: 16px 18px 12px;
	}
	.artifact-pane__eyebrow {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 650;
		color: var(--accent-fg);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.artifact-pane h2 {
		margin: 3px 0 0;
		font-family: var(--font-display);
		font-size: 18px;
		line-height: 1.2;
		letter-spacing: 0;
	}
	.artifact-pane__icon {
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
	.artifact-pane__formats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 4px;
		padding: 0 18px 12px;
	}
	.artifact-pane__format {
		min-height: 34px;
		padding: 5px 8px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-1);
		background: var(--bg-page);
		color: var(--fg-2);
		font-size: 11.5px;
		line-height: 1.2;
		letter-spacing: 0;
		text-align: left;
		cursor: pointer;
	}
	.artifact-pane__format--active {
		border-color: var(--cobalt-500);
		background: color-mix(in srgb, var(--cobalt-100) 55%, var(--bg-surface));
		color: var(--cobalt-700);
		font-weight: 650;
	}
	.artifact-pane__format:disabled {
		cursor: default;
		opacity: 0.65;
	}
	.artifact-pane__status {
		min-height: 35px;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 8px 18px;
		border-block: 1px solid var(--border-soft);
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		letter-spacing: 0;
	}
	.artifact-pane__pulse {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--cobalt-500);
		animation: artifact-pulse 1.2s ease-in-out infinite;
	}
	.artifact-pane__body {
		overflow-y: auto;
		padding: 18px;
		font-size: 14px;
		line-height: 1.55;
	}
	.artifact-pane__skeleton {
		display: grid;
		gap: 10px;
	}
	.artifact-pane__skeleton span {
		height: 10px;
		border-radius: var(--radius-1);
		background: var(--bg-raised);
	}
	.artifact-pane__skeleton span:nth-child(2) { width: 88%; }
	.artifact-pane__skeleton span:nth-child(3) { width: 64%; }
	.artifact-pane__footer {
		display: flex;
		gap: 8px;
		padding: 12px 18px;
		border-top: 1px solid var(--border-default);
		background: var(--bg-page);
	}
	.artifact-pane__button {
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
		letter-spacing: 0;
		cursor: pointer;
	}
	.artifact-pane__button:disabled { opacity: 0.5; cursor: default; }
	.artifact-pane__icon:hover,
	.artifact-pane__button:hover:not(:disabled) { background: var(--bg-raised); color: var(--fg-1); }
	.artifact-pane__icon:focus-visible,
	.artifact-pane__format:focus-visible,
	.artifact-pane__button:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
	@keyframes artifact-pulse { 50% { opacity: 0.35; } }
	@media (prefers-reduced-motion: reduce) { .artifact-pane__pulse { animation: none; } }
	@media (max-width: 860px) {
		.artifact-pane {
			position: fixed;
			inset: 48px 0 0;
			z-index: 60;
			width: 100%;
			min-width: 0;
			border-left: 0;
			border-top: 1px solid var(--border-default);
			box-shadow: var(--shadow-3);
		}
		.artifact-pane__footer { padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }
	}
</style>
