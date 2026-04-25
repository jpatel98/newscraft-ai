<script lang="ts">
	import '$lib/styles/foundations.css';
	import '$lib/styles/components.css';

	import { page } from '$app/state';
	import Plus from 'lucide-svelte/icons/plus';
	import Settings from 'lucide-svelte/icons/settings';
	import LogOut from 'lucide-svelte/icons/log-out';
	import Hash from 'lucide-svelte/icons/hash';

	let { children, data } = $props();

	const onLogin = $derived(page.url.pathname === '/login');

	function relTime(ts: number): string {
		const ms = Date.now() - ts;
		const m = Math.floor(ms / 60_000);
		if (m < 1) return 'just now';
		if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h`;
		const d = Math.floor(h / 24);
		return `${d}d`;
	}
</script>

<svelte:head>
	<title>NewsCraft</title>
</svelte:head>

{#if onLogin || !data.user}
	{@render children()}
{:else}
	<div class="shell">
		<aside class="sidebar">
			<div class="sidebar__masthead">
				<a class="sidebar__brand" href="/" aria-label="NewsCraft home">
					<img src="/brand/logo-mark-inverse.svg" alt="" />
					<span>NewsCraft</span>
				</a>
				<a
					class="sidebar__action"
					href="/"
					aria-label="New chat"
					title="New chat (Cmd+Shift+O)"
				>
					<Plus size="14" strokeWidth={2} />
					<span>New</span>
				</a>
			</div>

			<div class="sidebar__section">Threads</div>
			<div class="sidebar__list">
				{#if data.conversations.length === 0}
					<div class="sidebar__row" style="color:var(--ink-400);cursor:default">
						<span class="sidebar__row__name">No threads yet</span>
					</div>
				{/if}
				{#each data.conversations as c (c.id)}
					<a
						class="sidebar__row {page.params.id === c.id ? 'sidebar__row--active' : ''}"
						href={`/c/${c.id}`}
					>
						<Hash class="sidebar__row__glyph" size="14" strokeWidth={1.5} />
						<span class="sidebar__row__name">{c.title || 'Untitled thread'}</span>
						<span
							style="font-family:var(--font-mono);font-size:10px;color:var(--ink-400);text-transform:uppercase;letter-spacing:0.04em;flex-shrink:0"
							>{relTime(c.updatedAt)}</span
						>
					</a>
				{/each}
			</div>

			<div class="sidebar__footer">
				<a href="/settings" aria-label="Settings">
					<Settings size="14" strokeWidth={1.5} style="vertical-align:-2px;margin-right:4px" />
					Settings
				</a>
				<form method="post" action="/logout" style="display:inline;margin-left:auto">
					<button type="submit" aria-label="Sign out">
						<LogOut size="14" strokeWidth={1.5} style="vertical-align:-2px;margin-right:4px" />
						Sign out
					</button>
				</form>
			</div>
		</aside>

		<main class="pane">
			{@render children()}
		</main>
	</div>
{/if}
