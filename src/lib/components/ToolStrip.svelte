<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';

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
</script>

{#if chat.tools.length > 0}
	<div role="status" aria-live="off">
		{#each chat.tools as t (t.id)}
			<div class="tool-strip">
				<span class="pulse__dots" aria-hidden="true"
					><span></span><span></span><span></span></span
				>
				<span><strong>{t.name}</strong> · running for {age(t)}</span>
			</div>
		{/each}
	</div>
{/if}
