<script lang="ts">
	let { data, form } = $props<{
		data: { account: { email: string; name: string } };
		form?: { error?: string };
	}>();
	let pwInput: HTMLInputElement | undefined;
	$effect(() => {
		pwInput?.focus();
	});
</script>

<svelte:head>
	<title>Set password · NewsCraft</title>
</svelte:head>

<div class="page page--centered">
	<form method="post" class="card" autocomplete="off">
		<div class="card__eyebrow">NewsCraft · Account setup</div>
		<h1 class="card__title">Set your password.</h1>

		<div class="settings__meta-row settings__meta-row--card">
			<span>Account</span>
			<strong>{data.account.name}</strong>
			<code>{data.account.email}</code>
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
			Save password
		</button>

		{#if form?.error}
			<div class="field__error">{form.error}</div>
		{/if}
	</form>
</div>

<style>
	.settings__meta-row--card {
		margin: 0 0 16px;
	}
</style>
