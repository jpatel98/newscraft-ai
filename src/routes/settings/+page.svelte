<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { tick } from 'svelte';
	import { activeHTMLElement, focusDialog, restoreFocus, trapTabKey } from '$lib/utils/focus';

	let { data } = $props();

	// --- Accounts ---
	let accountBusy = $state(false);
	let accountMsg = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
	let setupUrl = $state('');
	let setupLinkBusyId = $state<string | null>(null);
	let deleteBusyId = $state<string | null>(null);

	async function submitAccount(e: Event) {
		e.preventDefault();
		accountMsg = null;
		setupUrl = '';
		accountBusy = true;
		try {
			const r = await fetch('/api/settings/accounts', {
				method: 'POST'
			});
			if (!r.ok) {
				accountMsg = { kind: 'err', text: 'Could not create the setup link.' };
				return;
			}
			const j = (await r.json()) as { setupUrl: string };
			setupUrl = j.setupUrl;
			accountMsg = { kind: 'ok', text: 'Setup link created.' };
			await invalidateAll();
		} catch {
			accountMsg = { kind: 'err', text: 'Could not create the setup link.' };
		} finally {
			accountBusy = false;
		}
	}

	async function createSetupLink(accountId: string) {
		accountMsg = null;
		setupUrl = '';
		setupLinkBusyId = accountId;
		try {
			const r = await fetch(`/api/settings/accounts/${encodeURIComponent(accountId)}/setup-link`, {
				method: 'POST'
			});
			if (!r.ok) {
				accountMsg = { kind: 'err', text: 'Could not create the setup link.' };
				return;
			}
			const j = (await r.json()) as { setupUrl: string };
			setupUrl = j.setupUrl;
			accountMsg = { kind: 'ok', text: 'Setup link created.' };
		} catch {
			accountMsg = { kind: 'err', text: 'Could not create the setup link.' };
		} finally {
			setupLinkBusyId = null;
		}
	}

	async function copySetupUrl() {
		if (!setupUrl) return;
		try {
			await navigator.clipboard.writeText(setupUrl);
			accountMsg = { kind: 'ok', text: 'Setup link copied.' };
		} catch {
			accountMsg = { kind: 'err', text: 'Could not copy the setup link.' };
		}
	}

	async function removeAccount(accountId: string, label: string) {
		if (!confirm(`Remove ${label}?`)) return;
		accountMsg = null;
		deleteBusyId = accountId;
		try {
			const r = await fetch(`/api/settings/accounts/${encodeURIComponent(accountId)}`, {
				method: 'DELETE'
			});
			if (!r.ok) {
				accountMsg = { kind: 'err', text: 'Could not remove the account.' };
				return;
			}
			setupUrl = '';
			accountMsg = { kind: 'ok', text: 'Account removed.' };
			await invalidateAll();
		} catch {
			accountMsg = { kind: 'err', text: 'Could not remove the account.' };
		} finally {
			deleteBusyId = null;
		}
	}

	function formatDate(ms: number | null) {
		if (!ms) return 'Never';
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(new Date(ms));
	}

	function accountLabel(account: { isCurrent?: boolean; name: string }, index: number) {
		return account.name || (account.isCurrent ? 'Current account' : `Account ${index + 1}`);
	}

	// --- Newsroom context ---
	let newsroomTimezone = $state('');
	let newsroomHomeMarket = $state('');
	let newsroomDomains = $state('');
	let newsroomHydrated = $state(false);
	let newsroomBusy = $state(false);
	let newsroomMsg = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);

	$effect(() => {
		if (newsroomHydrated) return;
		newsroomTimezone = data.newsroomProfile.timezone;
		newsroomHomeMarket = data.newsroomProfile.homeMarket;
		newsroomDomains = data.newsroomProfile.preferredDomains.join(', ');
		newsroomHydrated = true;
	});

	async function submitNewsroomProfile(e: Event) {
		e.preventDefault();
		newsroomBusy = true;
		newsroomMsg = null;
		try {
			const preferredDomains = newsroomDomains
				.split(/[\s,]+/)
				.map((domain) => domain.trim())
				.filter(Boolean);
			const response = await fetch('/api/settings/newsroom-profile', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({
					timezone: newsroomTimezone,
					homeMarket: newsroomHomeMarket,
					preferredDomains
				})
			});
			const result = (await response.json().catch(() => null)) as
				| {
						message?: string;
						profile?: { timezone: string; homeMarket: string; preferredDomains: string[] };
				  }
				| null;
			if (!response.ok || !result?.profile) {
				newsroomMsg = {
					kind: 'err',
					text: result?.message || 'Could not save newsroom context.'
				};
				return;
			}
			newsroomTimezone = result.profile.timezone;
			newsroomHomeMarket = result.profile.homeMarket;
			newsroomDomains = result.profile.preferredDomains.join(', ');
			newsroomMsg = { kind: 'ok', text: 'Newsroom context saved.' };
		} catch {
			newsroomMsg = { kind: 'err', text: 'Could not save newsroom context.' };
		} finally {
			newsroomBusy = false;
		}
	}

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
			pwMsg = { kind: 'err', text: 'New password must be at least 8 characters.' };
			return;
		}
		if (pwNew !== pwConfirm) {
			pwMsg = { kind: 'err', text: 'New password and confirmation do not match.' };
			return;
		}
		if (pwNew === pwCurrent) {
			pwMsg = { kind: 'err', text: 'New password must differ from current.' };
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
				pwMsg = { kind: 'err', text: 'Could not update the password.' };
				return;
			}
			pwMsg = { kind: 'ok', text: 'Password updated.' };
			pwCurrent = '';
			pwNew = '';
			pwConfirm = '';
		} catch {
			pwMsg = { kind: 'err', text: 'Could not update the password.' };
		} finally {
			pwBusy = false;
		}
	}

	// --- Wipe DB ---
	let wipePhrase = $state('');
	let wipeBusy = $state(false);
	let wipeShowConfirm = $state(false);
	let wipeMsg = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
	let wipeDialog = $state<HTMLDivElement | null>(null);
	let wipeCancelButton = $state<HTMLButtonElement | null>(null);
	let wipeOpener = $state<HTMLElement | null>(null);
	let wasWipeConfirmOpen = false;
	const PHRASE = 'WIPE-EVERYTHING';
	const wipeArmed = $derived(wipePhrase === PHRASE);

	function openWipeConfirm() {
		if (!wipeArmed) return;
		wipeShowConfirm = true;
	}
	function cancelWipe() {
		if (wipeBusy) return;
		wipeShowConfirm = false;
	}

	function onWipeKeydown(event: KeyboardEvent) {
		if (trapTabKey(event, wipeDialog)) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			cancelWipe();
		}
	}

	$effect(() => {
		if (wipeShowConfirm && !wasWipeConfirmOpen) {
			wipeOpener = activeHTMLElement();
			void tick().then(() => {
				if (wipeShowConfirm) focusDialog(wipeDialog, wipeCancelButton);
			});
		} else if (!wipeShowConfirm && wasWipeConfirmOpen) {
			const restoreTarget = wipeOpener;
			wipeOpener = null;
			void tick().then(() => restoreFocus(restoreTarget));
		}
		wasWipeConfirmOpen = wipeShowConfirm;
	});

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
				wipeMsg = { kind: 'err', text: 'Could not wipe conversations.' };
				wipeShowConfirm = false;
				return;
			}
			await invalidateAll();
			goto('/');
		} catch {
			wipeMsg = { kind: 'err', text: 'Could not wipe conversations.' };
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
			<div class="settings__eyebrow">Settings</div>
			<h1 class="settings__title">Account &amp; preferences</h1>
			<p class="settings__intro">
				Manage account access, conversation data, password, and signed-in sessions.
			</p>
		</header>

		<section class="settings__group" aria-labelledby="settings-account">
			<div class="settings__group__head">
				<h2 id="settings-account" class="settings__group__title">Account</h2>
				<p class="settings__group__copy">Manage sign-in state and account access.</p>
			</div>
			<div class="settings__section-body">
				<div class="settings__stats" aria-label="Account summary">
					<div class="settings__stat">
						<div class="settings__stat__label">Status</div>
						<div class="settings__stat__value">{data.user ? 'Signed in' : 'Signed out'}</div>
					</div>
					<div class="settings__stat">
						<div class="settings__stat__label">Conversations</div>
						<div class="settings__stat__value">{data.conversations.length}</div>
					</div>
					<div class="settings__stat">
						<div class="settings__stat__label">Account</div>
						<div class="settings__stat__value">
							{data.user?.name || data.user?.email || 'Current'}
						</div>
					</div>
				</div>
				{#if data.canManageAccounts}
					<div class="accounts-panel">
					<form class="settings__form accounts-create" onsubmit={submitAccount} autocomplete="off">
						<div class="settings__section-title">New account link</div>
						<p class="settings__section-copy">
							Create a one-time setup link. The person who opens it only needs to choose a
							password.
						</p>
						<div class="settings__form-actions">
							<button type="submit" class="btn btn--primary" disabled={accountBusy}>
								{accountBusy ? 'Creating…' : 'Create setup link'}
							</button>
						</div>
					</form>

					{#if setupUrl}
						<div class="setup-link">
							<label class="field__label" for="setup-url">Setup link</label>
							<div class="setup-link__row">
								<input
									id="setup-url"
									class="field__input"
									type="text"
									readonly
									value={setupUrl}
									onfocus={(e) => e.currentTarget.select()}
								/>
								<button type="button" class="btn btn--ghost" onclick={copySetupUrl}>Copy</button>
							</div>
							<div class="settings__hint">Share this link with the account owner.</div>
						</div>
					{/if}

					{#if accountMsg}
						<div class={accountMsg.kind === 'ok' ? 'settings__ok' : 'field__error'}>
							{accountMsg.text}
						</div>
					{/if}

					<div class="accounts-list" aria-label="Accounts">
						{#each data.accounts as account, i (account.id)}
							<div class="account-row">
								<div class="account-row__main">
									<div class="account-row__name">
										{accountLabel(account, i)}
										{#if account.isCurrent}
											<span>Current</span>
										{/if}
									</div>
									<div class="account-row__meta">
										<span>{account.email}</span>
										<span>{account.status === 'active' ? 'Active' : 'Pending setup'}</span>
										<span>Last login: {formatDate(account.lastLoginAt)}</span>
									</div>
								</div>
								<div class="account-row__actions">
									<button
										type="button"
										class="btn btn--ghost"
										disabled={setupLinkBusyId === account.id}
										onclick={() => createSetupLink(account.id)}
									>
										{#if setupLinkBusyId === account.id}
											Creating…
										{:else if account.status === 'active'}
											Reset link
										{:else}
											Setup link
										{/if}
									</button>
									<button
										type="button"
										class="btn btn--ghost"
										disabled={account.isCurrent || deleteBusyId === account.id}
										onclick={() => removeAccount(account.id, accountLabel(account, i))}
									>
										{deleteBusyId === account.id ? 'Removing…' : 'Remove'}
									</button>
								</div>
							</div>
						{/each}
					</div>
					</div>
				{/if}
			</div>
			</section>

			<section class="settings__group" aria-labelledby="settings-newsroom">
				<div class="settings__group__head">
					<h2 id="settings-newsroom" class="settings__group__title">Newsroom</h2>
					<p class="settings__group__copy">Set the local context used for current reporting.</p>
				</div>
				<div class="settings__section-body">
					<form class="settings__form newsroom-form" onsubmit={submitNewsroomProfile}>
						<div class="field">
							<label class="field__label" for="newsroom-timezone">Timezone</label>
							<input
								id="newsroom-timezone"
								class="field__input"
								type="text"
								list="newsroom-timezones"
								bind:value={newsroomTimezone}
								required
								spellcheck="false"
								autocomplete="off"
							/>
							<datalist id="newsroom-timezones">
								<option value="America/Toronto"></option>
								<option value="America/Vancouver"></option>
								<option value="America/Edmonton"></option>
								<option value="America/Winnipeg"></option>
								<option value="America/Halifax"></option>
								<option value="America/St_Johns"></option>
								<option value="America/New_York"></option>
								<option value="America/Chicago"></option>
								<option value="America/Denver"></option>
								<option value="America/Los_Angeles"></option>
								<option value="Europe/London"></option>
								<option value="UTC"></option>
							</datalist>
						</div>
						<div class="field">
							<label class="field__label" for="newsroom-market">Home market</label>
							<input
								id="newsroom-market"
								class="field__input"
								type="text"
								maxlength="120"
								bind:value={newsroomHomeMarket}
								placeholder="Toronto, Ontario"
							/>
						</div>
						<div class="field">
							<label class="field__label" for="newsroom-domains">Preferred domains</label>
							<textarea
								id="newsroom-domains"
								class="field__input newsroom-form__domains"
								rows="3"
								bind:value={newsroomDomains}
								placeholder="cbc.ca, toronto.ca"
								spellcheck="false"
							></textarea>
						</div>
						<div class="settings__form-actions">
							<button type="submit" class="btn btn--primary" disabled={newsroomBusy}>
								{newsroomBusy ? 'Saving…' : 'Save newsroom context'}
							</button>
						</div>
						{#if newsroomMsg}
							<div class={newsroomMsg.kind === 'ok' ? 'settings__ok' : 'field__error'}>
								{newsroomMsg.text}
							</div>
						{/if}
					</form>
				</div>
			</section>

			<section class="settings__group" aria-labelledby="settings-data">
			<div class="settings__group__head">
				<h2 id="settings-data" class="settings__group__title">Data</h2>
				<p class="settings__group__copy">Download or remove conversation records.</p>
			</div>
			<div class="settings__section-body">
				<div class="settings__section-title">Export conversations</div>
				<p class="settings__section-copy">
					Download a copy of every conversation, newest conversations first.
				</p>
				<a class="btn btn--ghost" href="/api/settings/export" download>
					Download conversations
				</a>
			</div>
		</section>

		<section class="settings__group" aria-labelledby="settings-security">
			<div class="settings__group__head">
				<h2 id="settings-security" class="settings__group__title">Security</h2>
				<p class="settings__group__copy">Update the password for this account.</p>
			</div>
			<div class="settings__section-body">
				<form class="settings__form" onsubmit={submitPassword} autocomplete="off">
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
					<div class="settings__form-actions">
						<button type="submit" class="btn btn--primary" disabled={pwBusy}>
							{pwBusy ? 'Updating…' : 'Update password'}
						</button>
					</div>
					{#if pwMsg}
						<div class={pwMsg.kind === 'ok' ? 'settings__ok' : 'field__error'}>
							{pwMsg.text}
						</div>
					{/if}
				</form>
			</div>
		</section>

		<section class="settings__group" aria-labelledby="settings-session">
			<div class="settings__group__head">
				<h2 id="settings-session" class="settings__group__title">Sessions</h2>
				<p class="settings__group__copy">End the current browser session.</p>
			</div>
			<div class="settings__section-body settings__session">
				<div>
					<div class="settings__section-title">Signed in session</div>
					<p class="settings__section-copy">Sign out of this device.</p>
				</div>
				<form method="post" action="/logout">
					<button type="submit" class="btn btn--ghost">Sign out</button>
				</form>
			</div>
		</section>

		<section class="settings__group settings__group--danger" aria-labelledby="settings-danger">
			<div class="settings__group__head">
				<h2 id="settings-danger" class="settings__group__title">Danger zone</h2>
				<p class="settings__group__copy">Destructive actions require confirmation.</p>
			</div>
			<div class="settings__section-body">
				<div class="settings__danger">
					<div class="settings__danger__title">Wipe all conversations</div>
					<div class="settings__danger__copy">
						Deletes every conversation and message. Accounts and passwords are kept. This
						cannot be undone.
					</div>
					<div class="field settings__danger__field">
						<label class="field__label" for="wipe-phrase">
							Type <code class="settings__phrase">{PHRASE}</code>
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
	</div>
</div>

{#if wipeShowConfirm}
	<div
		bind:this={wipeDialog}
		class="kbd-help"
		role="dialog"
		aria-modal="true"
		aria-labelledby="wipe-confirm-title"
		aria-describedby="wipe-confirm-copy"
		tabindex="-1"
		onkeydown={onWipeKeydown}
	>
		<button
			type="button"
			class="modal-backdrop"
			aria-label="Close dialog"
			aria-hidden="true"
			tabindex="-1"
			onclick={cancelWipe}
		></button>
		<div class="kbd-help__panel" role="document">
			<div id="wipe-confirm-title" class="kbd-help__title">Wipe everything?</div>
			<div class="kbd-help__sub">This cannot be undone</div>
			<p id="wipe-confirm-copy" class="settings__confirm-copy">
				All {data.conversations.length} conversation{data.conversations.length === 1 ? '' : 's'}
				and every message will be deleted. Accounts and passwords stay.
			</p>
			<div class="settings__confirm-actions">
				<button
					bind:this={wipeCancelButton}
					type="button"
					class="btn btn--ghost"
					onclick={cancelWipe}
					disabled={wipeBusy}
				>
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
		color: var(--signal-700);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-top: 6px;
	}
	.settings__stat__value {
		overflow-wrap: anywhere;
	}
	.accounts-panel {
		display: grid;
		gap: 16px;
	}
	.accounts-create {
		display: grid;
		gap: 10px;
	}
	.newsroom-form {
		max-width: 680px;
	}
	.newsroom-form__domains {
		min-height: 84px;
		resize: vertical;
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.setup-link {
		display: grid;
		gap: 6px;
		max-width: 680px;
	}
	.setup-link__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
	}
	.accounts-list {
		border-top: 1px solid var(--border-soft);
	}
	.account-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		padding: 12px 0;
		border-bottom: 1px solid var(--border-soft);
	}
	.account-row__main {
		min-width: 0;
		display: grid;
		gap: 3px;
	}
	.account-row__name {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		font-weight: 700;
		color: var(--fg-1);
		overflow-wrap: anywhere;
	}
	.account-row__name span,
	.account-row__meta {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.account-row__name span {
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-1);
		padding: 1px 5px;
		background: var(--bg-raised);
	}
	.account-row__meta {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.account-row__actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}
	.settings__danger {
		border: 1px solid var(--flag-700);
		border-radius: var(--radius-2);
		padding: 16px;
		max-width: 520px;
		background: color-mix(in srgb, var(--flag-50) 34%, var(--bg-surface));
	}
	.settings__danger__title {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 700;
		letter-spacing: 0;
		color: var(--flag-700);
		margin-bottom: 4px;
	}
	.settings__danger__copy {
		font-size: 13px;
		color: var(--fg-2);
		line-height: 1.5;
	}
	.settings__danger__field {
		margin-top: 12px;
	}
	.settings__phrase {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--flag-700);
	}
	.settings__confirm-copy {
		font-size: 14px;
		color: var(--fg-1);
		margin: 0 0 18px;
		line-height: 1.5;
	}
	.settings__confirm-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
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
	@media (max-width: 520px) {
		.account-row,
		.setup-link__row {
			grid-template-columns: 1fr;
		}
		.account-row__actions {
			justify-content: flex-start;
		}
		.settings__confirm-actions {
			flex-direction: column-reverse;
		}
		.settings__confirm-actions :global(.btn) {
			width: 100%;
		}
	}
</style>
