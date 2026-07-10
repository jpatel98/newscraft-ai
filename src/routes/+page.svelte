<script lang="ts">
	import { ArrowRight, BadgeCheck, GitCompareArrows, Newspaper, Radio, ShieldCheck } from 'lucide-svelte';
	import Composer from '$lib/components/Composer.svelte';

	let { data } = $props();
	let composer: Composer | undefined = $state();

	const starterPrompts = [
		'Toronto housing: find the newest reliable updates from the past 24 hours, cite source links, and flag anything unconfirmed.',
		'Toronto mayoral race: compare how CBC, CTV, and Global News are covering it today, including what each outlet emphasizes and leaves out.',
		'Ontario health care: find recent official and reputable media sources with publication dates, then summarize the three most newsworthy developments.',
		'Canadian immigration policy: build a producer brief with the latest official updates, major reactions, and unanswered questions.'
	] as const;

	const suggestionChips = [
		{ label: 'Latest on a story', icon: Radio, prompt: starterPrompts[0] },
		{ label: 'Compare coverage', icon: GitCompareArrows, prompt: starterPrompts[1] },
		{ label: 'Find with sources', icon: BadgeCheck, prompt: starterPrompts[2] },
		{ label: 'Research a beat', icon: Newspaper, prompt: starterPrompts[3] }
	] as const;
</script>

<svelte:head>
	<title>{data.isMarketingHost ? 'NewsCraft AI' : 'New chat · NewsCraft'}</title>
</svelte:head>

{#if data.isMarketingHost}
	<main class="landing" aria-labelledby="landing-title">
		<nav class="landing__nav" aria-label="NewsCraft">
			<a class="landing__brand" href="/" aria-label="NewsCraft AI home">
				<img src="/brand/logo-mark.svg" alt="" />
				<span>NewsCraft AI</span>
			</a>
			<a class="landing__nav-link" href="https://agent.newscraftai.com/login">Sign in</a>
		</nav>

		<section class="landing__hero">
			<div class="landing__copy">
				<p class="landing__eyebrow">Newsroom agent</p>
				<h1 id="landing-title">AI assistance built for live editorial work.</h1>
				<p>
					NewsCraft helps producers research, compare coverage, draft newsroom-ready copy, and keep
					source discipline visible while stories move.
				</p>
				<div class="landing__actions">
					<a class="landing__primary" href="https://agent.newscraftai.com/login">
						Open agent
						<ArrowRight size="17" strokeWidth={1.8} aria-hidden="true" />
					</a>
					<a class="landing__secondary" href="mailto:jigar@newscraftai.com">Contact</a>
				</div>
			</div>

			<div class="landing__visual" aria-label="NewsCraft workflow preview">
				<div class="landing__panel">
					<div class="landing__panel-head">
						<span></span>
						<span></span>
						<span></span>
					</div>
					<div class="landing__prompt">Compare CBC and CTV coverage of the mayor.</div>
					<div class="landing__step">
						<Radio size="16" strokeWidth={1.8} />
						<span>Search source-backed coverage</span>
					</div>
					<div class="landing__step">
						<GitCompareArrows size="16" strokeWidth={1.8} />
						<span>Separate claims, context, and gaps</span>
					</div>
					<div class="landing__answer">
						<strong>Producer brief</strong>
						<p>Coverage differs on the policy angle, quoted voices, and what remains unconfirmed.</p>
					</div>
				</div>
			</div>
		</section>

		<section class="landing__features" aria-label="NewsCraft capabilities">
			<div>
				<BadgeCheck size="18" strokeWidth={1.8} />
				<h2>Source-aware answers</h2>
				<p>Use live research when facts need verification, and answer directly when they do not.</p>
			</div>
			<div>
				<Newspaper size="18" strokeWidth={1.8} />
				<h2>Newsroom workflows</h2>
				<p>Draft briefs, research beats, compare outlets, and turn notes into usable editorial output.</p>
			</div>
			<div>
				<ShieldCheck size="18" strokeWidth={1.8} />
				<h2>Controlled tools</h2>
				<p>Keep auth, tenant scope, private-network safety, and tool boundaries enforced.</p>
			</div>
		</section>
	</main>
{:else}
	<main class="chat-start" aria-labelledby="chat-start-title">
		<section class="chat-start__content">
			<header class="chat-start__hero">
				<p class="chat-start__eyebrow">Newsroom research</p>
				<h1 id="chat-start-title">What should NewsCraft work on?</h1>
				<p>Ask about a story, source, topic, or newsroom task.</p>
			</header>

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
		</section>
	</main>
{/if}

<style>
	.landing {
		min-height: 100dvh;
		color: var(--fg-1);
		background: var(--bg-canvas);
	}

	.landing__nav {
		width: min(1120px, calc(100% - 32px));
		margin: 0 auto;
		padding: 18px 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.landing__brand,
	.landing__nav-link,
	.landing__primary,
	.landing__secondary {
		color: inherit;
		text-decoration: none;
	}

	.landing__brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-weight: var(--fw-semibold);
	}

	.landing__brand img {
		width: 30px;
		height: 30px;
		border-radius: 7px;
	}

	.landing__nav-link {
		font-size: var(--fs-body-sm);
		color: var(--fg-2);
	}

	.landing__hero {
		width: min(1120px, calc(100% - 32px));
		min-height: min(700px, calc(100dvh - 76px));
		margin: 0 auto;
		display: grid;
		grid-template-columns: minmax(0, 0.95fr) minmax(320px, 1.05fr);
		gap: 48px;
		align-items: center;
	}

	.landing__copy {
		display: grid;
		gap: 18px;
	}

	.landing__eyebrow {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--accent-fg);
	}

	.landing h1 {
		margin: 0;
		max-width: 720px;
		font-family: var(--font-display);
		font-size: clamp(44px, 7vw, 76px);
		line-height: 0.98;
		letter-spacing: 0;
	}

	.landing__copy > p:not(.landing__eyebrow) {
		margin: 0;
		max-width: 620px;
		color: var(--fg-2);
		font-size: 18px;
		line-height: 1.55;
	}

	.landing__actions {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		margin-top: 4px;
	}

	.landing__primary,
	.landing__secondary {
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border-radius: var(--radius-2);
		padding: 0 16px;
		font-weight: var(--fw-semibold);
	}

	.landing__primary {
		background: var(--fg-1);
		color: var(--bg-canvas);
	}

	.landing__secondary {
		border: 1px solid var(--border-soft);
		color: var(--fg-2);
		background: var(--bg-surface);
	}

	.landing__visual {
		min-height: 430px;
		display: grid;
		place-items: center;
	}

	.landing__panel {
		width: min(520px, 100%);
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-3);
		background: var(--bg-surface);
		box-shadow: var(--shadow-2);
		padding: 16px;
		display: grid;
		gap: 14px;
	}

	.landing__panel-head {
		display: flex;
		gap: 6px;
	}

	.landing__panel-head span {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--border-default);
	}

	.landing__prompt,
	.landing__answer {
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--bg-raised);
		padding: 14px;
	}

	.landing__prompt {
		font-weight: var(--fw-semibold);
	}

	.landing__step {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--fg-2);
		font-size: var(--fs-body-sm);
	}

	.landing__step :global(svg) {
		color: var(--accent-fg);
	}

	.landing__answer p {
		margin: 8px 0 0;
		color: var(--fg-2);
		line-height: 1.5;
	}

	.landing__features {
		width: min(1120px, calc(100% - 32px));
		margin: -18px auto 0;
		padding-bottom: 36px;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 18px;
	}

	.landing__features > div {
		border-top: 1px solid var(--border-soft);
		padding-top: 18px;
		display: grid;
		gap: 8px;
	}

	.landing__features :global(svg) {
		color: var(--accent-fg);
	}

	.landing__features h2 {
		margin: 0;
		font-size: 15px;
	}

	.landing__features p {
		margin: 0;
		color: var(--fg-2);
		line-height: 1.5;
		font-size: var(--fs-body-sm);
	}

	.chat-start {
		width: 100%;
		min-height: 100dvh;
		display: flex;
		justify-content: center;
		padding: calc(env(safe-area-inset-top, 0px) + 8px) var(--space-4)
			calc(env(safe-area-inset-bottom, 0px) + 10px);
	}

	.chat-start__content {
		width: min(760px, 100%);
		display: grid;
		gap: var(--space-3);
		align-content: start;
		color: var(--fg-1);
	}

	.chat-start__hero {
		display: grid;
		gap: var(--space-2);
	}

	.chat-start h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(28px, 7vw, 36px);
		line-height: 1.12;
		letter-spacing: 0;
		font-weight: var(--fw-semibold);
	}

	.chat-start__eyebrow {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-3);
	}

	.chat-start p {
		margin: var(--space-2) 0 0;
		color: var(--fg-3);
		font-size: var(--fs-body);
		line-height: var(--lh-body);
	}

	.chat-start__composer {
		margin-top: 2px;
	}

	.chat-start__prompts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-2);
	}

	.chat-start__prompts button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 44px;
		width: 100%;
		padding: 11px var(--space-3);
		border-radius: var(--radius-2);
		border: 1px solid var(--border-soft);
		background: var(--bg-surface);
		color: var(--fg-1);
		font: inherit;
		font-size: var(--fs-body-sm);
		line-height: var(--lh-body-sm);
		cursor: pointer;
		box-shadow: var(--shadow-0);
		transition:
			background var(--dur-fast) var(--ease-std),
			border-color var(--dur-fast) var(--ease-std),
			color var(--dur-fast) var(--ease-std);
		white-space: normal;
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
		.landing__nav,
		.landing__hero,
		.landing__features {
			width: min(100% - 28px, 1120px);
		}

		.landing__hero {
			grid-template-columns: 1fr;
			gap: 28px;
			padding: 26px 0 0;
		}

		.landing h1 {
			font-size: 42px;
			line-height: 1.02;
		}

		.landing__copy > p:not(.landing__eyebrow) {
			font-size: 16px;
		}

		.landing__visual {
			min-height: auto;
		}

		.landing__features {
			margin-top: 28px;
			grid-template-columns: 1fr;
		}

		.chat-start {
			padding: calc(env(safe-area-inset-top, 0px) + 10px) 12px
				calc(env(safe-area-inset-bottom, 0px) + 10px);
			gap: var(--space-4);
		}

		.chat-start h1 {
			font-size: 28px;
			line-height: 1.1;
		}

		.chat-start p {
			font-size: 13px;
		}
		.chat-start__prompts {
			grid-template-columns: 1fr;
		}
	}
</style>
