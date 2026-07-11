<script lang="ts">
	import { page } from '$app/state';
	let { form } = $props<{ form?: { error?: string; email?: string } }>();
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
	<form method="post" class="card" autocomplete="on">
		<div class="card__eyebrow">NewsCraft · Sign in</div>
		<h1 class="card__title">Welcome back.</h1>
		<p class="card__copy" id="login-access-note">
			Sign in to continue your newsroom research.
		</p>

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
				aria-describedby={hasError ? 'login-error' : 'login-access-note'}
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
				bind:this={pwInput}
				required
				aria-invalid={hasError ? 'true' : undefined}
				aria-describedby={hasError ? 'login-error' : 'login-access-note'}
			/>
		</div>

		<button type="submit" class="btn btn--primary" style="width:100%;padding:10px 16px">
			Sign in
		</button>

		<a class="auth-link" href="/signup">New to NewsCraft? Create an account</a>

		{#if form?.error}
			<div id="login-error" class="field__error" role="alert" aria-live="assertive">
				{form.error}
			</div>
		{/if}
	</form>
</div>
