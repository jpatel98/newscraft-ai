<script lang="ts">
	let { data } = $props();
</script>

<div style="max-width:560px;margin:2rem auto;padding:1rem;font-family:system-ui">
	<h1 style="margin-bottom:1rem">Settings</h1>
	<p style="color:#666">Foundation only — full settings UI lands with the design system.</p>
	<dl style="display:grid;grid-template-columns:auto 1fr;gap:0.5rem 1rem;margin-top:1.5rem">
		<dt>Signed in</dt>
		<dd>{data.user ? 'yes' : 'no'}</dd>
		<dt>Conversations</dt>
		<dd>{data.conversations.length}</dd>
	</dl>
	<form method="post" action="/logout" style="margin-top:2rem">
		<button
			type="submit"
			style="padding:0.5rem 0.75rem;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer"
		>
			Sign out
		</button>
	</form>
</div>
