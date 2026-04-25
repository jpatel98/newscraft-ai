<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<title>Settings · NewsCraft</title>
</svelte:head>

<div class="page">
	<div class="settings">
		<header class="settings__masthead">
			<div class="settings__eyebrow">Settings · v0.1</div>
			<h1 class="settings__title">Account &amp; preferences</h1>
		</header>

		<section class="settings__row">
			<div class="settings__row__label">Signed in</div>
			<div class="settings__row__value">{data.user ? 'Yes' : 'No'}</div>
		</section>

		<section class="settings__row">
			<div class="settings__row__label">Threads</div>
			<div class="settings__row__value">
				{data.conversations.length} on record
			</div>
		</section>

		<section class="settings__row">
			<div class="settings__row__label">Theme</div>
			<div class="settings__row__value">System default · light + dark.</div>
		</section>

		<section class="settings__row">
			<div class="settings__row__label">Agent</div>
			<div class="settings__row__value">
				NewsCraft · model <code style="font-family:var(--font-mono);font-size:13px">hermes-agent</code>
			</div>
		</section>

		<section class="settings__row">
			<div class="settings__row__label">Session</div>
			<div class="settings__row__value">
				<form method="post" action="/logout">
					<button type="submit" class="btn btn--ghost">Sign out</button>
				</form>
			</div>
		</section>
	</div>
</div>
