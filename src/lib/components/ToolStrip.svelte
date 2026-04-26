<script lang="ts">
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import { chat } from '$lib/stores/chat.svelte';
	import ToolInspector, { type InspectorToolCall } from './ToolInspector.svelte';

	let now = $state(Date.now());
	$effect(() => {
		if (chat.tools.length === 0) return;
		const i = setInterval(() => (now = Date.now()), 500);
		return () => clearInterval(i);
	});

	function age(t: { startedAt: number }): string {
		const s = Math.max(0, Math.floor((now - t.startedAt) / 1000));
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
	}

	let inspectorOpen = $state(false);
	let focusId = $state<string | null>(null);

	const inspectorCalls = $derived<InspectorToolCall[]>(
		chat.tools.map((t) => ({
			id: t.id,
			name: t.name,
			status: 'running',
			startedAt: t.startedAt
		}))
	);

	function inspect(id: string) {
		focusId = id;
		inspectorOpen = true;
	}
</script>

{#if chat.tools.length > 0}
	<div role="status" aria-live="off">
		{#each chat.tools as t (t.id)}
			<div class="tool-strip">
				<span class="pulse__dots" aria-hidden="true"
					><span></span><span></span><span></span></span
				>
				<span><strong>{t.name}</strong> · running for {age(t)}</span>
				<button
					type="button"
					class="tool-strip__inspect"
					onclick={() => inspect(t.id)}
					aria-label="Inspect tool call"
				>
					<ChevronRight size="12" strokeWidth={1.75} />
				</button>
			</div>
		{/each}
	</div>
{/if}

<ToolInspector
	toolCalls={inspectorCalls}
	open={inspectorOpen}
	{focusId}
	onClose={() => (inspectorOpen = false)}
/>
