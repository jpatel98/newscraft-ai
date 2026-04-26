<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';

	let { data } = $props();

	// --- Change password ---
	let pwCurrent = $state('');
	let pwNew = $state('');
	let pwConfirm = $state('');
	let pwBusy = $state(false);
	let pwMsg = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);

	async function submitPassword(e: Event) {
		e.preventDefault();
		pwMsg = null;
		if (pwNew.length < 8) {
			pwMsg = { kind: 'err', text: 'new password must be at least 8 characters' };
			return;
		}
		if (pwNew !== pwConfirm) {
			pwMsg = { kind: 'err', text: 'new password and confirmation do not match' };
			return;
		}
		if (pwNew === pwCurrent) {
			pwMsg = { kind: 'err', text: 'new password must differ from current' };
			return;
		}
		pwBusy = true;
		try {
			const r = await fetch('/api/settings/password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ current: pwCurrent, new: pwNew })
			});
			if (!r.ok) {
				const t = await r.text();
				pwMsg = { kind: 'err', text: t || `error ${r.status}` };
				return;
			}
			pwMsg = { kind: 'ok', text: 'password updated' };
			pwCurrent = '';
			pwNew = '';
			pwConfirm = '';
		} catch (err) {
			pwMsg = { kind: 'err', text: (err as Error).message };
		} finally {
			pwBusy = false;
		}
	}

	// --- Wipe DB ---
	let wipePhrase = $state('');
	let wipeBusy = $state(false);
	let wipeShowConfirm = $state(false);
	let wipeMsg = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
	const PHRASE = 'WIPE-EVERYTHING';
	const wipeArmed = $derived(wipePhrase === PHRASE);

	function openWipeConfirm() {
		if (!wipeArmed) return;
		wipeShowConfirm = true;
	}
	function cancelWipe() {
		wipeShowConfirm = false;
	}

	async function confirmWipe() {
		wipeBusy = true;
		wipeMsg = null;
		try {
			const r = await fetch('/api/settings/wipe-db', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirm: PHRASE })
			});
			if (!r.ok) {
				const t = await r.text();
				wipeMsg = { kind: 'err', text: t || `error ${r.status}` };
				wipeShowConfirm = false;
				return;
			}
			await invalidateAll();
			goto('/');
		} catch (err) {
			wipeMsg = { kind: 'err', text: (err as Error).message };
			wipeShowConfirm = false;
		} finally {
			wipeBusy = false;
		}
	}
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
				NewsCraft · model
				<code style="font-family:var(--font-mono);font-size:13px">hermes-agent</code>
			</div>
		</section>

		<section class="settings__row">
			<div class="settings__row__label">Password</div>
			<div class="settings__row__value">
				<form onsubmit={submitPassword} autocomplete="off" style="max-width:360px">
					<div class="field">
						<label class="field__label" for="pw-current">Current password</label>
						<input
							id="pw-current"
							class="field__input"
							type="password"
							autocomplete="current-password"
							bind:value={pwCurrent}
							required
						/>
					</div>
					<div class="field">
						<label class="field__label" for="pw-new">New password</label>
						<input
							id="pw-new"
							class="field__input"
							type="password"
							autocomplete="new-password"
							minlength={8}
							bind:value={pwNew}
							required
						/>
					</div>
					<div class="field">
						<label class="field__label" for="pw-confirm">Confirm new password</label>
						<input
							id="pw-confirm"
							class="field__input"
							type="password"
							autocomplete="new-password"
							minlength={8}
							bind:value={pwConfirm}
							required
						/>
					</div>
					<button type="submit" class="btn btn--primary" disabled={pwBusy}>
						{pwBusy ? 'Updating…' : 'Update password'}
					</button>
					{#if pwMsg}
						<div class={pwMsg.kind === 'ok' ? 'settings__ok' : 'field__error'}>
							{pwMsg.text}
						</div>
					{/if}
				</form>
			</div>
		</section>

		<section class="settings__row">
			<div class="settings__row__label">Export</div>
			<div class="settings__row__value">
				<a class="btn btn--ghost" href="/api/settings/export" download>
					Download all conversations (JSONL)
				</a>
				<div class="settings__hint">
					One record per line. Conversations newest-first; messages chronological.
				</div>
			</div>
		</section>

		<section class="settings__row settings__row--danger">
			<div class="settings__row__label">Danger zone</div>
			<div class="settings__row__value">
				<div class="settings__danger">
					<div class="settings__danger__title">Wipe all conversations</div>
					<div class="settings__danger__copy">
						Deletes every conversation and message. Settings (including this password) are kept.
						This cannot be undone.
					</div>
					<div class="field" style="margin-top:12px">
						<label class="field__label" for="wipe-phrase">
							Type <code style="font-family:var(--font-mono);font-size:12px">{PHRASE}</code>
							to enable
						</label>
						<input
							id="wipe-phrase"
							class="field__input"
							type="text"
							autocomplete="off"
							spellcheck="false"
							bind:value={wipePhrase}
						/>
					</div>
					<button
						type="button"
						class="btn btn--danger"
						disabled={!wipeArmed || wipeBusy}
						onclick={openWipeConfirm}
					>
						Wipe everything
					</button>
					{#if wipeMsg}
						<div class={wipeMsg.kind === 'ok' ? 'settings__ok' : 'field__error'}>
							{wipeMsg.text}
						</div>
					{/if}
				</div>
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

{#if wipeShowConfirm}
	<div
		class="kbd-help"
		role="dialog"
		aria-modal="true"
		aria-labelledby="wipe-confirm-title"
		tabindex="-1"
		onkeydown={(e) => {
			if (e.key === 'Escape') cancelWipe();
		}}
	>
		<button
			type="button"
			class="modal-backdrop"
			aria-label="Close dialog"
			onclick={cancelWipe}
		></button>
		<div class="kbd-help__panel" role="document">
			<div id="wipe-confirm-title" class="kbd-help__title">Wipe everything?</div>
			<div class="kbd-help__sub">This cannot be undone</div>
			<p style="font-size:14px;color:var(--fg-1);margin:0 0 18px">
				All {data.conversations.length} conversation{data.conversations.length === 1 ? '' : 's'}
				and every message will be deleted. Your password and theme stay.
			</p>
			<div style="display:flex;gap:8px;justify-content:flex-end">
				<button type="button" class="btn btn--ghost" onclick={cancelWipe} disabled={wipeBusy}>
					Cancel
				</button>
				<button
					type="button"
					class="btn btn--danger"
					onclick={confirmWipe}
					disabled={wipeBusy}
				>
					{wipeBusy ? 'Wiping…' : 'Yes, wipe everything'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.settings__hint {
		margin-top: 8px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.settings__ok {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--cobalt-700);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-top: 6px;
	}
	@media (prefers-color-scheme: dark) {
		.settings__ok {
			color: var(--cobalt-300);
		}
	}
	.settings__row--danger {
		border-top: 1px solid var(--border-default);
	}
	.settings__danger {
		border: 1px solid var(--flag-700);
		padding: 14px 16px;
		max-width: 480px;
	}
	@media (prefers-color-scheme: dark) {
		.settings__danger {
			border-color: var(--flag-300);
		}
	}
	.settings__danger__title {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 700;
		letter-spacing: -0.012em;
		color: var(--flag-700);
		margin-bottom: 4px;
	}
	@media (prefers-color-scheme: dark) {
		.settings__danger__title {
			color: var(--flag-300);
		}
	}
	.settings__danger__copy {
		font-size: 13px;
		color: var(--fg-2);
		line-height: 1.5;
	}
	:global(.btn--danger) {
		background: var(--flag-700);
		color: var(--ink-25);
		border-color: var(--flag-700);
	}
	:global(.btn--danger:hover:not(:disabled)) {
		background: var(--flag-800, var(--flag-700));
		border-color: var(--flag-800, var(--flag-700));
		filter: brightness(0.92);
	}
	:global(.btn--danger:active:not(:disabled)) {
		transform: translateY(1px);
		filter: brightness(0.85);
	}
	.modal-backdrop {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		background: transparent;
		border: 0;
		padding: 0;
		margin: 0;
		cursor: default;
	}
	.modal-backdrop:focus-visible {
		outline: none;
	}
</style>
