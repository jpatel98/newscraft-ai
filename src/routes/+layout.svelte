<script lang="ts">
	import { page } from '$app/state';
	let { children, data } = $props();

	const onChat = $derived(page.url.pathname.startsWith('/c/') || page.url.pathname === '/');
	const onLogin = $derived(page.url.pathname === '/login');
</script>

<svelte:head>
	<title>Hermes</title>
</svelte:head>

{#if onLogin || !data.user}
	{@render children()}
{:else}
	<div style="display:grid;grid-template-columns:240px 1fr;height:100vh;font-family:system-ui">
		<aside style="border-right:1px solid #eee;padding:0.75rem;overflow:auto">
			<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
				<strong>Hermes</strong>
				<a href="/" style="font-size:0.85rem">+ new</a>
			</div>
			<nav style="display:flex;flex-direction:column;gap:0.25rem">
				{#each data.conversations as c (c.id)}
					<a
						href={`/c/${c.id}`}
						style:background={page.params.id === c.id ? '#eef' : 'transparent'}
						style="padding:0.4rem 0.5rem;border-radius:4px;text-decoration:none;color:#222;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
					>
						{c.title}
					</a>
				{/each}
			</nav>
			<div style="margin-top:1rem;border-top:1px solid #eee;padding-top:0.75rem">
				<a href="/settings" style="font-size:0.85rem;color:#555">Settings</a>
				<form method="post" action="/logout" style="display:inline;margin-left:0.5rem">
					<button
						type="submit"
						style="background:none;border:0;color:#555;font-size:0.85rem;cursor:pointer;padding:0"
						>Logout</button
					>
				</form>
			</div>
		</aside>
		<main style="overflow:auto">
			{@render children()}
		</main>
	</div>
{/if}
