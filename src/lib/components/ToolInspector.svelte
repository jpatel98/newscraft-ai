<script lang="ts" module>
	export interface InspectorToolCall {
		id: string;
		name: string;
		status?: 'running' | 'ok' | 'failed' | 'unknown';
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		arguments?: unknown;
		result?: unknown;
		transcript?: string;
	}
</script>

<script lang="ts">
	import X from 'lucide-svelte/icons/x';
	import JsonTree from './JsonTree.svelte';

	interface Props {
		toolCalls: InspectorToolCall[];
		open: boolean;
		focusId?: string | null;
		onClose: () => void;
	}
	let { toolCalls, open, focusId = null, onClose }: Props = $props();

	let expanded = $state<Record<string, boolean>>({});

	$effect(() => {
		if (!open) return;
		// On open, expand the focused row (or the first one) by default.
		const target = focusId && toolCalls.some((t) => t.id === focusId)
			? focusId
			: toolCalls[0]?.id;
		if (target) expanded = { ...expanded, [target]: true };
	});

	function toggle(id: string) {
		expanded = { ...expanded, [id]: !expanded[id] };
	}

	function fmtDuration(t: InspectorToolCall): string {
		if (typeof t.durationMs === 'number') {
			const ms = t.durationMs;
			if (ms < 1000) return `${ms}ms`;
			return `${(ms / 1000).toFixed(1)}s`;
		}
		if (t.startedAt && t.endedAt) {
			const ms = t.endedAt - t.startedAt;
			return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
		}
		if (t.status === 'running' && t.startedAt) {
			const s = Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000));
			return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
		}
		return '—';
	}

	function statusOf(t: InspectorToolCall): 'running' | 'ok' | 'failed' | 'unknown' {
		return t.status ?? 'unknown';
	}

	function hasArgs(t: InspectorToolCall): boolean {
		return t.arguments !== undefined && t.arguments !== null;
	}
	function hasResult(t: InspectorToolCall): boolean {
		return t.result !== undefined && t.result !== null;
	}

	function onKey(e: KeyboardEvent) {
		if (open && e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<button
		type="button"
		class="ti-backdrop"
		aria-label="Close inspector"
		onclick={onClose}
	></button>
	<div class="ti-panel" role="dialog" aria-label="Tool-call inspector" aria-modal="true">
		<header class="ti-panel__head">
			<div>
				<div class="ti-panel__eyebrow">Tools</div>
				<h2 class="ti-panel__title">Tool-call inspector</h2>
			</div>
			<button type="button" class="ti-close" onclick={onClose} aria-label="Close">
				<X size="14" strokeWidth={1.5} />
			</button>
		</header>

		<div class="ti-panel__body">
			{#if toolCalls.length === 0}
				<div class="ti-empty">No tool calls.</div>
			{:else}
				{#each toolCalls as t (t.id)}
					{@const isOpen = !!expanded[t.id]}
					{@const s = statusOf(t)}
					<section class="ti-call" class:ti-call--open={isOpen}>
						<button
							type="button"
							class="ti-call__head"
							onclick={() => toggle(t.id)}
							aria-expanded={isOpen}
						>
							<span class="ti-call__caret" class:ti-call__caret--open={isOpen} aria-hidden="true">▸</span>
							<span class="ti-call__name">{t.name}</span>
							<span class="ti-call__dur">{fmtDuration(t)}</span>
							<span class="ti-status ti-status--{s}">{s}</span>
						</button>

						{#if isOpen}
							<div class="ti-call__body">
								<div class="ti-section">
									<div class="ti-section__label">Arguments</div>
									{#if hasArgs(t)}
										<div class="ti-json">
											<JsonTree value={t.arguments} />
										</div>
									{:else}
										<div class="ti-section__placeholder">— arguments not captured</div>
									{/if}
								</div>

								<div class="ti-section">
									<div class="ti-section__label">Result</div>
									{#if hasResult(t)}
										<div class="ti-json">
											<JsonTree value={t.result} />
										</div>
									{:else if s === 'running'}
										<div class="ti-section__placeholder">— still running</div>
									{:else}
										<div class="ti-section__placeholder">— result not captured</div>
									{/if}
								</div>

								{#if t.transcript}
									<div class="ti-section">
										<div class="ti-section__label">Transcript</div>
										<pre class="ti-transcript">{t.transcript}</pre>
									</div>
								{/if}
							</div>
						{/if}
					</section>
				{/each}
			{/if}
		</div>
	</div>
{/if}
