<script lang="ts">
	import {
		ArrowRight,
		ArrowUpRight,
		BadgeCheck,
		GitCompareArrows,
		MessageSquare,
		Newspaper,
		Radio,
		ShieldCheck
	} from 'lucide-svelte';
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
			label: 'Catch up on a developing story',
			description: 'Newest confirmed facts, changes, and open questions',
			icon: Radio,
			prompt: starterPrompts[0]
		},
		{
			label: 'Compare how outlets frame it',
			description: 'Differences in emphasis, sourcing, and omissions',
			icon: GitCompareArrows,
			prompt: starterPrompts[1]
		},
		{
			label: 'Find primary evidence',
			description: 'Official records and reputable reporting with dates',
			icon: BadgeCheck,
			prompt: starterPrompts[2]
		},
		{
			label: 'Build a producer brief',
			description: 'Key facts, reactions, and questions for the rundown',
			icon: Newspaper,
			prompt: starterPrompts[3]
		}
	] as const;

	const firstName = $derived(data.user?.name?.trim().split(/\s+/)[0] || '');
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
		<section class="chat-start__desk">
			<header class="chat-start__hero">
				<div class="chat-start__identity">
					<img src="/brand/newscraft-agent-avatar.png" alt="" />
					<span>Newsroom desk</span>
				</div>
				{#if firstName}<p class="chat-start__welcome">Welcome back, {firstName}</p>{/if}
				<h1 id="chat-start-title">What are you working on?</h1>
				<p class="chat-start__lead">
					Research a developing story, compare coverage, or turn sources into usable copy.
				</p>
			</header>

			<section class="chat-start__composer" aria-label="Start a new chat">
				<Composer
					bind:this={composer}
					placeholder="Ask about a story, source, or newsroom task..."
					draftKey="new"
				/>
			</section>

			<div class:chat-start__workspace--solo={recentThreads.length === 0} class="chat-start__workspace">
				<section class="chat-start__tasks" aria-labelledby="starter-prompts-title">
					<div class="chat-start__section-head">
						<h2 id="starter-prompts-title">Start with a newsroom task</h2>
						<span>Choose a starting point</span>
					</div>
					<div class="chat-start__prompts" aria-label="Starter prompts">
						{#each suggestionChips as card}
							{@const Icon = card.icon}
							<button
								type="button"
								aria-label={card.prompt}
								onclick={() => composer?.setValue(card.prompt)}
							>
								<span class="chat-start__prompt-icon"><Icon strokeWidth={1.8} aria-hidden="true" /></span>
								<span class="chat-start__prompt-copy">
									<strong>{card.label}</strong>
									<small>{card.description}</small>
								</span>
								<span class="chat-start__prompt-arrow">
									<ArrowRight size="15" strokeWidth={1.8} aria-hidden="true" />
								</span>
							</button>
						{/each}
					</div>
				</section>

				{#if recentThreads.length > 0}
					<section class="chat-start__recent" aria-labelledby="recent-work-title">
						<div class="chat-start__section-head">
							<h2 id="recent-work-title">Recent work</h2>
							<span>{recentThreads.length} thread{recentThreads.length === 1 ? '' : 's'}</span>
						</div>
						<div class="chat-start__recent-list">
							{#each recentThreads as thread (thread.id)}
								<a href={`/c/${thread.id}`}>
									<MessageSquare size="15" strokeWidth={1.7} aria-hidden="true" />
									<span>
										<strong>{thread.title}</strong>
										<small>{formatRelativeTime(thread.updatedAt)}</small>
									</span>
									<ArrowUpRight size="14" strokeWidth={1.7} aria-hidden="true" />
								</a>
							{/each}
						</div>
					</section>
				{/if}
			</div>
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
		display: grid;
		justify-items: center;
		padding: clamp(64px, 11vh, 124px) clamp(24px, 5vw, 72px)
			calc(env(safe-area-inset-bottom, 0px) + 36px);
		background:
			linear-gradient(var(--border-soft), var(--border-soft)) top 30px center / min(1080px, calc(100% - 48px)) 1px no-repeat,
			var(--bg-page);
	}

	.chat-start__desk {
		width: min(980px, 100%);
		display: grid;
		gap: 22px;
		align-content: start;
		color: var(--fg-1);
	}

	.chat-start__hero {
		display: grid;
		gap: 8px;
		max-width: 760px;
	}

	.chat-start h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 42px;
		line-height: 1.08;
		letter-spacing: 0;
		font-weight: 650;
	}

	.chat-start__identity {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		width: fit-content;
		margin-bottom: 8px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-2);
	}

	.chat-start__identity img {
		width: 28px;
		height: 28px;
		border-radius: var(--radius-2);
		object-fit: cover;
	}

	.chat-start__welcome {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-3);
	}

	.chat-start__lead {
		max-width: 650px;
		margin: 2px 0 0;
		color: var(--fg-2);
		font-size: 15px;
		line-height: 1.55;
	}

	.chat-start__composer {
		width: min(840px, 100%);
	}

	.chat-start__composer :global(.composer) {
		min-height: 62px;
		border-color: var(--border-default);
		box-shadow: 0 8px 28px rgb(14 14 13 / 7%);
	}

	.chat-start__workspace {
		display: grid;
		grid-template-columns: minmax(0, 1.65fr) minmax(240px, 0.8fr);
		gap: 32px;
		padding-top: 6px;
	}

	.chat-start__workspace--solo {
		grid-template-columns: minmax(0, 720px);
	}

	.chat-start__tasks,
	.chat-start__recent {
		min-width: 0;
	}

	.chat-start__section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 9px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--border-soft);
	}

	.chat-start__section-head h2 {
		margin: 0;
		font-size: 12px;
		font-weight: 650;
		letter-spacing: 0;
	}

	.chat-start__section-head span {
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.chat-start__prompts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.chat-start__prompts button {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr) 16px;
		align-items: start;
		gap: 10px;
		min-height: 78px;
		width: 100%;
		padding: 12px;
		border-radius: var(--radius-2);
		border: 1px solid var(--border-soft);
		background: var(--bg-surface);
		color: var(--fg-1);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-std),
			border-color var(--dur-fast) var(--ease-std),
			transform var(--dur-fast) var(--ease-std);
	}

	.chat-start__prompts button:hover {
		border-color: var(--border-default);
		background: var(--bg-raised);
		transform: translateY(-1px);
	}

	.chat-start__prompts button:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}

	.chat-start__prompt-icon {
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border-radius: var(--radius-1);
		background: var(--bg-raised);
		color: var(--accent-fg);
	}

	.chat-start__prompt-icon :global(svg) {
		width: 15px;
		height: 15px;
	}

	.chat-start__prompt-copy {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.chat-start__prompt-copy strong,
	.chat-start__recent-list strong {
		font-size: 12.5px;
		line-height: 1.35;
		font-weight: 650;
		letter-spacing: 0;
		overflow-wrap: anywhere;
	}

	.chat-start__prompt-copy small {
		color: var(--fg-3);
		font-size: 10.5px;
		line-height: 1.4;
		letter-spacing: 0;
	}

	.chat-start__prompt-arrow {
		display: grid;
		place-items: center;
		margin-top: 7px;
		color: var(--fg-4);
		transition: color var(--dur-fast) var(--ease-std);
	}

	.chat-start__prompts button:hover .chat-start__prompt-arrow {
		color: var(--accent-fg);
	}

	.chat-start__recent-list {
		display: grid;
	}

	.chat-start__recent-list a {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr) 14px;
		align-items: start;
		gap: 8px;
		min-height: 54px;
		padding: 10px 2px;
		border-bottom: 1px solid var(--border-soft);
		color: var(--fg-2);
		text-decoration: none;
	}

	.chat-start__recent-list a > span {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.chat-start__recent-list strong {
		display: -webkit-box;
		overflow: hidden;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		color: var(--fg-1);
	}

	.chat-start__recent-list small {
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--fg-3);
		letter-spacing: 0;
	}

	.chat-start__recent-list a > :global(svg:last-child) {
		color: var(--fg-4);
	}

	.chat-start__recent-list a:hover strong,
	.chat-start__recent-list a:hover > :global(svg:last-child) {
		color: var(--accent-fg);
	}

	.chat-start__recent-list a:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
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
			padding: calc(env(safe-area-inset-top, 0px) + 78px) 16px
				calc(env(safe-area-inset-bottom, 0px) + 24px);
			background: var(--bg-page);
		}

		.chat-start h1 {
			font-size: 32px;
			line-height: 1.08;
		}

		.chat-start__desk {
			gap: 18px;
		}

		.chat-start__workspace {
			grid-template-columns: 1fr;
			gap: 24px;
		}

		.chat-start__composer {
			width: 100%;
		}

		.chat-start__recent {
			order: -1;
		}
	}

	@media (max-width: 520px) {
		.chat-start {
			padding-inline: 12px;
		}

		.chat-start__identity {
			margin-bottom: 2px;
		}

		.chat-start h1 {
			font-size: 29px;
		}

		.chat-start__lead {
			font-size: 13.5px;
		}

		.chat-start__prompts {
			grid-template-columns: 1fr;
		}

		.chat-start__prompts button {
			min-height: 68px;
		}

		.chat-start__section-head span {
			display: none;
		}
	}
</style>
