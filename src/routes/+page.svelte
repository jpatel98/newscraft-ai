<script lang="ts">
	import Composer from '$lib/components/Composer.svelte';

	let composer: Composer | undefined = $state();

	const starterPrompts = [
		'Track latest Toronto housing stories and summarize the newest reliable coverage.',
		'Find recent Canadian politics stories with publication dates and source links.',
		'Compare what major outlets are reporting about this topic: ',
		'Watch this source URL and tell me what changed: '
	];
</script>

<svelte:head>
	<title>Stories · NewsCraft</title>
</svelte:head>

<main class="stories-shell" aria-labelledby="stories-title">
	<section class="stories-hero">
		<div class="stories-hero__copy">
			<h1 id="stories-title">Story tracker</h1>
			<p>
				Track a topic, region, or story and send research straight into a newsroom-smart chat thread.
			</p>
		</div>
		<div class="stories-hero__status" aria-label="Story tracker status">
			<strong>0</strong>
			<span>active stories</span>
		</div>
	</section>

	<section class="tracker-panel" aria-label="Start tracking">
		<div class="tracker-panel__head">
			<h2>Start with a research prompt</h2>
			<p>Ask NewsCraft to find recent coverage, compare outlets, or monitor a source URL.</p>
		</div>
		<div class="starter-grid" aria-label="Starter prompts">
			{#each starterPrompts as prompt}
				<button type="button" onclick={() => composer?.setValue(prompt)}>{prompt}</button>
			{/each}
		</div>
		<Composer bind:this={composer} placeholder="Track a story, topic, region, or source URL..." />
	</section>

	<section class="empty-stories" aria-label="Tracked stories">
		<div>
			<h2>No tracked stories yet</h2>
			<p>Story cards will show the latest research updates, publication dates, and source links.</p>
		</div>
	</section>
</main>

<style>
	.stories-shell {
		display: grid;
		gap: var(--space-6);
		padding: var(--space-6);
		color: var(--fg-1);
	}

	.stories-hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--space-6);
		align-items: end;
		padding: var(--space-6) 0 var(--space-5);
		border-top: 2px solid var(--ink-900);
		border-bottom: 1px solid var(--border-soft);
	}

	.stories-hero h1 {
		margin: 0;
		font-family: var(--font-serif);
		font-size: 5rem;
		line-height: 0.95;
		letter-spacing: 0;
	}

	.stories-hero p,
	.tracker-panel__head p,
	.empty-stories p {
		margin: var(--space-3) 0 0;
		max-width: 44rem;
		color: var(--fg-2);
		font-size: var(--fs-body);
		line-height: 1.6;
	}

	.stories-hero__status {
		display: grid;
		gap: var(--space-1);
		min-width: 10rem;
		padding: var(--space-4);
		border-left: 1px solid var(--border-soft);
		text-align: right;
	}

	.stories-hero__status strong {
		font-family: var(--font-serif);
		font-size: 3rem;
		line-height: 1;
	}

	.stories-hero__status span {
		color: var(--fg-3);
		font-size: var(--fs-small);
	}

	.tracker-panel {
		display: grid;
		gap: var(--space-4);
		max-width: 62rem;
	}

	.tracker-panel__head h2,
	.empty-stories h2 {
		margin: 0;
		font-size: var(--fs-title);
		letter-spacing: 0;
	}

	.starter-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.starter-grid button {
		display: flex;
		min-height: 4rem;
		align-items: center;
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-md);
		color: var(--fg-1);
		background: var(--surface-1);
		text-align: left;
		font-size: var(--fs-small);
		line-height: 1.4;
		cursor: pointer;
	}

	.starter-grid button:hover {
		border-color: var(--border-strong);
		background: var(--surface-2);
	}

	.empty-stories {
		display: flex;
		min-height: 12rem;
		align-items: center;
		max-width: 62rem;
		padding: var(--space-6);
		border: 1px dashed var(--border-soft);
		border-radius: var(--radius-md);
		background: var(--surface-1);
	}

	@media (max-width: 760px) {
		.stories-shell {
			padding: var(--space-4);
		}

		.stories-hero {
			grid-template-columns: 1fr;
		}

		.stories-hero h1 {
			font-size: 3rem;
		}

		.stories-hero__status {
			width: 100%;
			border-left: 0;
			border-top: 1px solid var(--border-soft);
			text-align: left;
		}

		.starter-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
