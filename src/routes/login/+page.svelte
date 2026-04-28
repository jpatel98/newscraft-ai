<script lang="ts">
	import { page } from '$app/state';
	let { form } = $props<{ form?: { error?: string; email?: string } }>();
	const next = $derived(page.url.searchParams.get('next') ?? '/');
	let emailInput: HTMLInputElement | undefined;
	$effect(() => {
		emailInput?.focus();
	});
</script>

<svelte:head>
	<title>Sign in · NewsCraft</title>
</svelte:head>

<div class="page page--centered">
	<form method="post" class="card" autocomplete="off">
		<div class="card__eyebrow">NewsCraft · Sign in</div>
		<h1 class="card__title">Welcome back.</h1>

		<input type="hidden" name="next" value={next} />

		<div class="field">
			<label class="field__label" for="email">Email</label>
			<input
				id="email"
				class="field__input"
				type="email"
				name="email"
				autocomplete="username"
				value={form?.email ?? ''}
				bind:this={emailInput}
				required
			/>
		</div>

		<div class="field">
			<label class="field__label" for="pw">Password</label>
			<input
				id="pw"
				class="field__input"
				type="password"
				name="password"
				autocomplete="current-password"
				required
			/>
		</div>

		<button type="submit" class="btn btn--primary" style="width:100%;padding:10px 16px">
			Sign in
		</button>

		{#if form?.error}
			<div class="field__error">{form.error}</div>
		{/if}
	</form>
</div>
