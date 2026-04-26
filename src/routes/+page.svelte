<script lang="ts">
	import Composer from '$lib/components/Composer.svelte';

	let composer: Composer | undefined = $state();

	const starters = [
		'Draft a briefing from these notes',
		'Compare the latest coverage',
		'Turn this into an edit plan'
	];
</script>

<svelte:head>
	<title>NewsCraft</title>
</svelte:head>

<div class="empty">
	<div class="empty__eyebrow">New thread</div>
	<h1 class="empty__title">Start with a question or task.</h1>
	<div class="empty__prompts" aria-label="Starter prompts">
		{#each starters as starter}
			<button type="button" onclick={() => composer?.setValue(starter)}>{starter}</button>
		{/each}
	</div>
	<Composer bind:this={composer} placeholder="Ask NewsCraft to research, draft, or refine something..." />
	<div class="empty__hint">Messages, sources, and tool activity will appear here.</div>
</div>
