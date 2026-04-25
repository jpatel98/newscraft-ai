<script lang="ts">
	import Composer from '$lib/components/Composer.svelte';
	let { data } = $props();
</script>

<svelte:head>
	<title>NewsCraft</title>
</svelte:head>

<div class="empty">
	<div class="empty__eyebrow">New thread · {new Date().toISOString().slice(0, 10)}</div>
	<h1 class="empty__title">What are we working on?</h1>
	<Composer placeholder="Start a thread — e.g. “Pull the day's politics-desk hits.”" />
	<div class="empty__hint">
		{#if data.conversations.length > 0}
			Or pick a recent thread from the sidebar.
		{:else}
			This is the first thread. The agent's reply, sources, and tool runs will appear here.
		{/if}
	</div>
</div>
