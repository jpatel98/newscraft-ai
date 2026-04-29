<script lang="ts">
	import { replaceState } from '$app/navigation';
	import Composer from '$lib/components/Composer.svelte';
	import { onMount } from 'svelte';

	let composer: Composer | undefined = $state();

	const starters = [
		{
			label: 'Scan latest national news',
			prompt: 'Scan the latest national news and tell me what matters most right now.'
		},
		{
			label: 'Show breaking stories',
			prompt: 'Show me the top breaking stories right now and summarize why they matter.'
		},
		{
			label: 'Track updates on a topic',
			prompt: 'Track the latest updates on this topic: '
		}
	];

	onMount(() => {
		const draft = new URL(location.href).searchParams.get('draft');
		if (!draft) return;
		composer?.setValue(draft);
		replaceState('/', {});
	});
</script>

<svelte:head>
	<title>NewsCraft</title>
</svelte:head>

<div class="empty">
	<div class="empty__eyebrow">New thread</div>
	<h1 class="empty__title">Start with a question or task.</h1>
	<div class="empty__prompts" aria-label="Starter prompts">
		{#each starters as starter}
			<button type="button" onclick={() => composer?.setValue(starter.prompt)}>{starter.label}</button>
		{/each}
	</div>
	<Composer bind:this={composer} placeholder="Ask NewsCraft to scan, track, or explain the news..." />
	<div class="empty__hint">Messages, sources, and tool activity will appear here.</div>
</div>
