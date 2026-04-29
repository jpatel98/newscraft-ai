<script lang="ts">
	let { form } = $props<{
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
