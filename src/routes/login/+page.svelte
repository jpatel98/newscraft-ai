<script lang="ts">
	import { page } from '$app/state';
	let { form } = $props();
	const next = $derived(page.url.searchParams.get('next') ?? '/');
	let pwInput: HTMLInputElement | undefined;
	$effect(() => {
		pwInput?.focus();
	});
</script>

<svelte:head>
	<title>Sign in · Hermes</title>
</svelte:head>

<main style="max-width:320px;margin:10vh auto;font-family:system-ui">
	<h1 style="margin-bottom:1rem">Hermes</h1>
	<form method="post">
		<input type="hidden" name="next" value={next} />
		<label style="display:block;margin-bottom:0.5rem">
			<span style="display:block;font-size:0.85rem;color:#555">password</span>
			<input
				type="password"
				name="password"
				autocomplete="current-password"
				bind:this={pwInput}
				required
				style="width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:4px"
			/>
		</label>
		<button
			type="submit"
			style="width:100%;padding:0.5rem;border:0;border-radius:4px;background:#111;color:#fff;cursor:pointer"
		>
			Sign in
		</button>
		{#if form?.error}
			<p style="color:#c00;margin-top:0.75rem;font-size:0.9rem">{form.error}</p>
		{/if}
	</form>
</main>
