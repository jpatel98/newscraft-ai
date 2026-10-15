<script lang="ts">
	import { page } from '$app/state';

	const notFound = $derived(page.status === 404);
	const isChat = $derived(page.url.pathname.startsWith('/c/'));
	const title = $derived(
		notFound ? (isChat ? 'Chat not found' : 'Page not found') : 'Something went wrong'
	);
	const detail = $derived(
		notFound
			? isChat
				? 'This chat may have been deleted, or the link is incomplete.'
				: 'This link does not match a page in NewsCraft.'
			: 'Your chats are still saved. Try loading this page again.'
	);
</script>

<svelte:head><title>{title} · NewsCraft</title></svelte:head>

<section class="error-page" aria-labelledby="error-title">
	<div class="error-page__eyebrow">Error {page.status}</div>
	<h1 id="error-title" class="error-page__title">{title}</h1>
	<p class="error-page__detail">{detail}</p>
	<div class="error-page__actions">
		<a class="btn btn--primary" href="/">Back to chats</a>
		{#if !notFound}
			<button type="button" class="btn btn--ghost" onclick={() => window.location.reload()}>
				Reload page
			</button>
		{/if}
	</div>
</section>

<style>
	/* Sits inside the app pane, so the top padding keeps the heading clear of
	 * the floating command bar in the top-left corner. */
	.error-page {
		width: min(100%, 560px);
		margin: 0 auto;
		padding: 18vh 24px 72px;
		overflow-y: auto;
	}
	.error-page__eyebrow {
		border-top: 2px solid var(--ink-900);
		padding-top: 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.error-page__title {
		font-family: var(--font-display);
		font-size: 32px;
		font-weight: 700;
		letter-spacing: 0;
		margin: 4px 0 0;
		color: var(--fg-1);
	}
	.error-page__detail {
		margin: 10px 0 0;
		color: var(--fg-2);
		font-size: 14.5px;
		line-height: 1.5;
	}
	.error-page__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 24px;
	}
	@media (max-width: 760px) {
		.error-page {
			padding: calc(env(safe-area-inset-top, 0px) + 96px) 16px 56px;
		}
		.error-page__title {
			font-size: 26px;
		}
		.error-page__actions .btn {
			min-height: 44px;
		}
	}
</style>
