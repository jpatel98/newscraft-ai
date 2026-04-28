<script lang="ts">
	let { data, form } = $props<{
		data: { requiresBootstrapPassword: boolean };
		form?: { error?: string; email?: string; name?: string };
	}>();
	let emailInput: HTMLInputElement | undefined;
	$effect(() => {
		emailInput?.focus();
	});
</script>

<svelte:head>
	<title>Set up account · NewsCraft</title>
</svelte:head>

<div class="page page--centered">
	<form method="post" class="card" autocomplete="off">
		<div class="card__eyebrow">NewsCraft · Account setup</div>
		<h1 class="card__title">Create the first account.</h1>

		{#if data.requiresBootstrapPassword}
			<div class="field">
				<label class="field__label" for="bootstrap-pw">Current access password</label>
				<input
					id="bootstrap-pw"
					class="field__input"
					type="password"
					name="bootstrapPassword"
					autocomplete="current-password"
					required
				/>
			</div>
		{/if}

		<div class="field">
			<label class="field__label" for="name">Name</label>
			<input
				id="name"
				class="field__input"
				type="text"
				name="name"
				autocomplete="name"
				value={form?.name ?? ''}
			/>
		</div>

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
				autocomplete="new-password"
				minlength={8}
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

		{#if form?.error}
			<div class="field__error">{form.error}</div>
		{/if}
	</form>
</div>
