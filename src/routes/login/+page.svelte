<script lang="ts">
	import { page } from '$app/state';
	let { form } = $props<{ form?: { error?: string } }>();
	const next = $derived(page.url.searchParams.get('next') ?? '/');
	const hasError = $derived(Boolean(form?.error));
	let pwInput: HTMLInputElement | undefined;
	$effect(() => {
		pwInput?.focus();
	});
</script>

<svelte:head>
	<title>Sign in · NewsCraft</title>
</svelte:head>

<div class="page page--centered">
	<form method="post" class="card">
		<div class="card__eyebrow">NewsCraft · Sign in</div>
		<h1 class="card__title">Welcome back.</h1>
		<p class="card__copy" id="login-access-note">
			Use the password set for your account. New access is created by an admin setup link.
		</p>

		<input type="hidden" name="next" value={next} />

		<div class="field">
			<label class="field__label" for="pw">Password</label>
			<input
				id="pw"
				class="field__input"
				type="password"
				name="password"
				autocomplete="current-password"
				bind:this={pwInput}
				required
				aria-invalid={hasError ? 'true' : undefined}
				aria-describedby={hasError ? 'login-error' : 'login-access-note'}
			/>
		</div>

		<button type="submit" class="btn btn--primary" style="width:100%;padding:10px 16px">
			Sign in
		</button>

		{#if form?.error}
			<div id="login-error" class="field__error" role="alert" aria-live="assertive">
				{form.error}
			</div>
		{/if}
	</form>
</div>
