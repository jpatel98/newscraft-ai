<script lang="ts">
	let { data, form } = $props<{
		data: Record<string, never>;
		form?: { error?: string };
	}>();
	let pwInput: HTMLInputElement | undefined;
	$effect(() => {
		pwInput?.focus();
	});
</script>

<svelte:head>
	<title>Create account · NewsCraft</title>
</svelte:head>

<div class="page page--centered">
	<form method="post" class="card" autocomplete="off">
		<div class="card__eyebrow">NewsCraft · Create account</div>
		<h1 class="card__title">Set up your access.</h1>

		<div class="field">
			<label class="field__label" for="pw">Password</label>
			<input
				id="pw"
				class="field__input"
				type="password"
				name="password"
				autocomplete="new-password"
				minlength={8}
				bind:this={pwInput}
				required
			/>
		</div>

		<div class="field">
			<label class="field__label" for="confirm">Confirm password</label>
			<input
				id="confirm"
				class="field__input"
				type="password"
				name="confirm"
				autocomplete="new-password"
				minlength={8}
				required
			/>
		</div>

		<button type="submit" class="btn btn--primary" style="width:100%;padding:10px 16px">
			Create account
		</button>

		<a class="auth-link" href="/login">Already have an account? Sign in</a>

		{#if form?.error}
			<div class="field__error">{form.error}</div>
		{/if}
	</form>
</div>
