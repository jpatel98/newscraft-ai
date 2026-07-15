<script lang="ts">
	import { ArrowRight, BadgeCheck, GitCompareArrows, Newspaper, Radio, ShieldCheck } from 'lucide-svelte';
	import Composer from '$lib/components/Composer.svelte';
	import { formatRelativeTime } from '$lib/utils/time';

	let { data } = $props();
	let composer: Composer | undefined = $state();

	const starterPrompts = [
		'Toronto housing: find the newest reliable updates from the past 24 hours, cite source links, and flag anything unconfirmed.',
		'Toronto mayoral race: compare how CBC, CTV, and Global News are covering it today, including what each outlet emphasizes and leaves out.',
		'Ontario health care: find recent official and reputable media sources with publication dates, then summarize the three most newsworthy developments.',
		'Canadian immigration policy: build a producer brief with the latest official updates, major reactions, and unanswered questions.'
	] as const;

	const suggestionChips = [
		{
			label: 'Latest on a story',
			description: 'Build a verified update with dates and caveats.',
			icon: Radio,
			prompt: starterPrompts[0]
		},
		{
			label: 'Compare coverage',
			description: 'See how different outlets frame the same story.',
			icon: GitCompareArrows,
			prompt: starterPrompts[1]
		},
		{
			label: 'Find with sources',
			description: 'Start from official and reputable reporting.',
			icon: BadgeCheck,
			prompt: starterPrompts[2]
		},
		{
			label: 'Research a beat',
			description: 'Turn a broad topic into a producer-ready brief.',
			icon: Newspaper,
			prompt: starterPrompts[3]
		}
	] as const;

	const recentThreads = $derived((data.conversations ?? []).slice(0, 3));
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
						<div class="chat-start__eyebrow-row">
							<p class="chat-start__eyebrow">Newsroom research</p>
							<span class="chat-start__eyebrow-status">Source-aware workspace</span>
						</div>
						<h1 id="chat-start-title">What are you working on?</h1>
						<p>Start with a story, source, topic, or newsroom task. NewsCraft will keep the research trail visible.</p>
					</header>

			<section class="chat-start__composer" aria-label="Start a new chat">
				<Composer bind:this={composer} placeholder="Ask NewsCraft..." draftKey="new" />
			</section>

					<section class="chat-start__prompt-section" aria-labelledby="chat-start-prompts-title">
						<div class="chat-start__section-head">
							<div>
								<p class="chat-start__section-eyebrow">Quick starts</p>
								<h2 id="chat-start-prompts-title">Choose a newsroom move</h2>
							</div>
							<span class="chat-start__section-meta">4 workflows</span>
						</div>
						<div class="chat-start__prompts">
						{#each suggestionChips as card}
							{@const Icon = card.icon}
							<button type="button" aria-label={card.prompt} onclick={() => composer?.setValue(card.prompt)}>
								<span class="chat-start__prompt-icon"><Icon strokeWidth={1.8} aria-hidden="true" /></span>
								<span class="chat-start__prompt-copy">
									<strong>{card.label}</strong>
									<span>{card.description}</span>
								</span>
								<ArrowRight class="chat-start__prompt-arrow" size="15" strokeWidth={1.8} aria-hidden="true" />
							</button>
						{/each}
						</div>
					</section>

					{#if recentThreads.length > 0}
						<section class="chat-start__recent" aria-labelledby="chat-start-recent-title">
							<div class="chat-start__section-head">
								<div>
									<p class="chat-start__section-eyebrow">Recent work</p>
									<h2 id="chat-start-recent-title">Pick up where you left off</h2>
								</div>
								<span class="chat-start__section-meta">{(data.conversations ?? []).length} total</span>
							</div>
							<div class="chat-start__recent-list">
								{#each recentThreads as conversation (conversation.id)}
									<a class="chat-start__recent-row" href={`/c/${conversation.id}`}>
										<span class="chat-start__recent-mark" aria-hidden="true"></span>
										<span class="chat-start__recent-copy">
											<strong>{conversation.title || 'Untitled thread'}</strong>
											<span>{conversation.pinned ? 'Pinned · ' : ''}Updated {formatRelativeTime(conversation.updatedAt)}</span>
										</span>
										<ArrowRight class="chat-start__recent-arrow" size="15" strokeWidth={1.8} aria-hidden="true" />
									</a>
								{/each}
							</div>
						</section>
					{:else}
						<p class="chat-start__empty-note">Your recent work will appear here after your first research thread.</p>
					{/if}
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
		padding: calc(env(safe-area-inset-top, 0px) + 52px) var(--space-4)
			calc(env(safe-area-inset-bottom, 0px) + 40px);
	}

	.chat-start__content {
		width: min(760px, 100%);
		display: grid;
		gap: var(--space-8);
		align-content: start;
		color: var(--fg-1);
		padding: 48px 0 24px;
	}

	.chat-start__hero {
		display: grid;
		gap: var(--space-3);
		max-width: 680px;
	}

	.chat-start__eyebrow-row,
	.chat-start__section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
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
		margin: 0;
	}

	.chat-start__eyebrow-status,
	.chat-start__section-meta {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--accent-fg);
	}

	.chat-start__hero > p {
		margin: var(--space-2) 0 0;
		color: var(--fg-3);
		font-size: var(--fs-body-lg);
		line-height: 1.55;
	}

	.chat-start__composer {
		padding: var(--space-2);
		border: 1px solid var(--border-soft);
		background: color-mix(in srgb, var(--bg-surface) 52%, transparent);
		box-shadow: var(--shadow-1);
	}

	.chat-start__prompt-section,
	.chat-start__recent {
		display: grid;
		gap: var(--space-3);
	}

	.chat-start__section-head {
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--border-soft);
		align-items: end;
	}

	.chat-start__section-eyebrow {
		margin: 0 0 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--fg-3);
	}

	.chat-start__section-head h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 18px;
		line-height: 1.2;
		font-weight: 700;
	}

	.chat-start__prompts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.chat-start__prompts button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 86px;
		width: 100%;
		padding: var(--space-4);
		border-radius: var(--radius-2);
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
		color: var(--fg-1);
		font: inherit;
		font-size: var(--fs-body);
		line-height: var(--lh-body-sm);
		cursor: pointer;
		box-shadow: var(--shadow-1);
		transition:
			background var(--dur-fast) var(--ease-std),
			border-color var(--dur-fast) var(--ease-std),
			color var(--dur-fast) var(--ease-std);
		white-space: normal;
		text-align: left;
	}

	.chat-start__prompts button:hover {
		border-color: var(--border-default);
		background: var(--bg-raised);
		color: var(--accent-fg);
		box-shadow: var(--shadow-2);
	}

	.chat-start__prompts button:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}

	.chat-start__prompt-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		flex: none;
		border: 1px solid var(--cobalt-100);
		border-radius: var(--radius-2);
		background: var(--accent-soft);
		color: var(--accent-fg);
	}

	.chat-start__prompt-copy,
	.chat-start__recent-copy {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.chat-start__prompt-copy strong,
	.chat-start__recent-copy strong {
		font-weight: 650;
		color: var(--fg-1);
	}

	.chat-start__prompt-copy span,
	.chat-start__recent-copy span {
		color: var(--fg-3);
		font-size: 12px;
		line-height: 1.4;
	}

	:global(.chat-start__prompt-arrow),
	:global(.chat-start__recent-arrow) {
		margin-left: auto;
		flex: none;
		color: var(--fg-3);
		transition: transform var(--dur-fast) var(--ease-std), color var(--dur-fast) var(--ease-std);
	}

	.chat-start__prompts button:hover :global(.chat-start__prompt-arrow),
	.chat-start__recent-row:hover :global(.chat-start__recent-arrow) {
		color: var(--accent-fg);
		transform: translateX(2px);
	}

	.chat-start__recent-list {
		display: grid;
		border: 1px solid var(--border-soft);
		background: var(--bg-surface);
	}

	.chat-start__recent-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 58px;
		padding: 10px 14px;
		color: var(--fg-1);
		text-decoration: none;
		border-bottom: 1px solid var(--border-soft);
		transition: background var(--dur-fast) var(--ease-std), color var(--dur-fast) var(--ease-std);
	}

	.chat-start__recent-row:last-child {
		border-bottom: 0;
	}

	.chat-start__recent-row:hover {
		background: var(--bg-raised);
	}

	.chat-start__recent-row:focus-visible {
		outline: none;
		box-shadow: inset var(--shadow-focus);
	}

	.chat-start__recent-mark {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--cobalt-400);
		box-shadow: 0 0 0 3px var(--accent-soft);
		flex: none;
	}

	.chat-start__empty-note {
		margin: 0;
		padding: var(--space-4);
		border: 1px dashed var(--border-default);
		color: var(--fg-3);
		font-size: var(--fs-body-sm);
		text-align: center;
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

		.chat-start__content {
			gap: var(--space-6);
			padding-top: 28px;
		}

		.chat-start h1 {
			font-size: 28px;
			line-height: 1.1;
		}

		.chat-start__hero > p {
			font-size: 13px;
		}
		.chat-start__eyebrow-status,
		.chat-start__section-meta {
			font-size: 9px;
		}
		.chat-start__section-head {
			align-items: start;
		}
		.chat-start__section-head h2 {
			font-size: 16px;
		}
		.chat-start__prompts {
			grid-template-columns: 1fr;
		}
		.chat-start__composer {
			padding: 4px;
		}
	}
</style>
