<script lang="ts">
	import { BadgeCheck, GitCompareArrows, Newspaper, Radio } from 'lucide-svelte';
	import Composer from '$lib/components/Composer.svelte';

	let composer: Composer | undefined = $state();

	const starterPrompts = [
		'What are the newest reliable updates on this story?',
		'Compare how major outlets are covering this topic: ',
		'Find recent Canadian politics stories with publication dates and source links.',
		'Track latest Toronto housing stories and summarize the newest reliable coverage.'
	] as const;

	const suggestionChips = [
		{ label: 'Latest on a story', icon: Radio, prompt: starterPrompts[0] },
		{ label: 'Compare coverage', icon: GitCompareArrows, prompt: starterPrompts[1] },
		{ label: 'Find with sources', icon: BadgeCheck, prompt: starterPrompts[2] },
		{ label: 'Track a beat', icon: Newspaper, prompt: starterPrompts[3] }
	] as const;
</script>

<svelte:head>
	<title>New chat · NewsCraft</title>
</svelte:head>

<main class="chat-start" aria-labelledby="chat-start-title">
	<section class="chat-start__hero">
		<div class="chat-start__copy">
			<h1 id="chat-start-title">What should NewsCraft work on?</h1>
			<p>Ask about a story, source, topic, or newsroom task.</p>
		</div>
	</section>

	<section class="chat-start__composer" aria-label="Start a new chat">
		<Composer bind:this={composer} placeholder="Ask NewsCraft..." />
	</section>

	<section class="chat-start__prompts" aria-label="Starter prompts">
		{#each suggestionChips as card}
			{@const Icon = card.icon}
			<button type="button" aria-label={card.prompt} onclick={() => composer?.setValue(card.prompt)}>
				<Icon strokeWidth={1.8} aria-hidden="true" />
				<span>{card.label}</span>
			</button>
		{/each}
	</section>
</main>

<style>
	.chat-start {
		width: min(720px, 100%);
		min-height: 100dvh;
		margin: 0 auto;
		padding: var(--space-6);
		display: grid;
		align-content: center;
		gap: var(--space-4);
		color: var(--fg-1);
	}

	.chat-start__hero {
		display: grid;
		justify-items: center;
		text-align: center;
	}

	.chat-start__copy {
		max-width: 42rem;
	}

	.chat-start h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(26px, 4vw, 32px);
		line-height: 1.12;
		letter-spacing: 0;
		font-weight: var(--fw-semibold);
	}

	.chat-start p {
		margin: var(--space-2) 0 0;
		color: var(--fg-3);
		font-size: var(--fs-body);
		line-height: var(--lh-body);
	}

	.chat-start__composer {
		margin-top: var(--space-2);
	}

	.chat-start__prompts {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-2);
	}

	.chat-start__prompts button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--space-8);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		color: var(--fg-1);
		font: inherit;
		font-size: var(--fs-body-sm);
		line-height: var(--lh-body-sm);
		white-space: nowrap;
		cursor: pointer;
		box-shadow: var(--shadow-0);
		transition:
			background var(--dur-fast) var(--ease-std),
			border-color var(--dur-fast) var(--ease-std),
			color var(--dur-fast) var(--ease-std);
	}

	.chat-start__prompts button:hover {
		border-color: var(--border-default);
		background: var(--bg-raised);
		color: var(--accent-fg);
	}

	.chat-start__prompts button:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}

	.chat-start__prompts button :global(svg) {
		width: var(--space-4);
		height: var(--space-4);
		flex: none;
	}

	@media (max-width: 760px) {
		.chat-start {
			min-height: 100dvh;
			padding: var(--space-5) var(--space-4);
			gap: var(--space-4);
		}

		.chat-start h1 {
			font-size: clamp(26px, 9vw, 32px);
		}

		.chat-start p {
			font-size: var(--fs-body);
		}
	}
</style>
