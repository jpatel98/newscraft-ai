<script lang="ts">
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { fuzzyRank } from '$lib/utils/fuzzy';
	import { activeHTMLElement, focusDialog, restoreFocus, trapTabKey } from '$lib/utils/focus';

	interface Conversation { id: string; title: string; updatedAt: number; }
	interface Cmd { id: string; label: string; hint?: string; enabled: boolean; run: () => void | Promise<void>; }
	interface Props { open: boolean; conversations: Conversation[]; onClose: () => void; }
	let { open, conversations, onClose }: Props = $props();

	const commands = $derived<Cmd[]>([
		{ id: 'new-chat', label: 'New chat', hint: '⌘⇧O', enabled: true, run: () => goto('/') },
		{ id: 'open-settings', label: 'Open settings', enabled: true, run: () => goto('/settings') },
		{
			id: 'abort-stream',
			label: 'Abort current stream',
			hint: 'Esc',
			enabled: chat.streaming,
			run: () => chat.cancel()
		},
		{
			id: 'sign-out',
			label: 'Sign out',
			enabled: true,
			run: async () => {
				await fetch('/logout', { method: 'POST', redirect: 'manual' });
				await goto('/login', { invalidateAll: true });
			}
		}
	]);

	let query = $state('');
	let active = $state(0);
	let dialogEl = $state<HTMLDivElement | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);
	let opener = $state<HTMLElement | null>(null);
	let wasOpen = false;

	const listboxId = 'command-palette-listbox';
	function optionId(i: number): string {
		return `command-palette-option-${i}`;
	}

	type Row =
		| { kind: 'cmd'; item: Cmd; section: 'COMMANDS' }
		| { kind: 'thread'; item: Conversation; section: 'THREADS' };

	const rows = $derived.by<Row[]>(() => {
		const cmdHits = fuzzyRank(query, commands, (c) => c.label).filter((h) => h.item.enabled);
		const threadHits = query
			? fuzzyRank(query, conversations, (c) => c.title || 'Untitled thread')
			: conversations.map((item) => ({ item, score: 0 }));
		const out: Row[] = [];
		for (const h of cmdHits) out.push({ kind: 'cmd', item: h.item, section: 'COMMANDS' });
		for (const h of threadHits) out.push({ kind: 'thread', item: h.item, section: 'THREADS' });
		return out.slice(0, 50);
	});

	$effect(() => { void rows; void query; active = 0; });

	$effect(() => {
		if (open && !wasOpen) {
			opener = activeHTMLElement();
			query = '';
			active = 0;
			void tick().then(() => {
				if (open) focusDialog(dialogEl, inputEl);
			});
		} else if (!open && wasOpen) {
			const restoreTarget = opener;
			opener = null;
			void tick().then(() => restoreFocus(restoreTarget));
		}
		wasOpen = open;
	});

	$effect(() => {
		if (!listEl) return;
		listEl.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	});

	function activate(i: number) {
		const row = rows[i];
		if (!row) return;
		onClose();
		if (row.kind === 'cmd') row.item.run();
		else goto(`/c/${row.item.id}`);
	}

	function onKeydown(e: KeyboardEvent) {
		if (trapTabKey(e, dialogEl)) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			e.stopPropagation();
			if (rows.length) active = (active + 1) % rows.length;
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			if (rows.length) active = (active - 1 + rows.length) % rows.length;
			return;
		}
		if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); activate(active); }
	}

	function sectionHead(i: number): string | null {
		if (i === 0) return rows[0].section;
		return rows[i].section !== rows[i - 1].section ? rows[i].section : null;
	}
</script>

{#if open}
	<div
		bind:this={dialogEl}
		class="cmdk"
		role="dialog"
		aria-label="Command palette"
		aria-modal="true"
		tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
		onkeydown={onKeydown}
	>
		<div class="cmdk__panel">
			<input
				bind:this={inputEl}
				bind:value={query}
				type="text"
				class="cmdk__input"
				placeholder="Type a command or search threads…"
				autocomplete="off"
				spellcheck="false"
				aria-label="Command palette search"
				role="combobox"
				aria-autocomplete="list"
				aria-expanded="true"
				aria-controls={listboxId}
				aria-activedescendant={rows[active] ? optionId(active) : undefined}
			/>
			<div id={listboxId} class="cmdk__list" bind:this={listEl} role="listbox" aria-label="Command palette results">
				{#if rows.length === 0}
					<div class="cmdk__empty">No matches</div>
				{/if}
				{#each rows as row, i (row.kind + ':' + row.item.id)}
					{@const head = sectionHead(i)}
					{#if head}<div class="cmdk__section">{head}</div>{/if}
					<div
						id={optionId(i)}
						class="cmdk__row {i === active ? 'cmdk__row--active' : ''}"
						role="option"
						aria-selected={i === active}
						tabindex="-1"
						data-i={i}
						onmousemove={() => (active = i)}
						onclick={() => activate(i)}
						onkeydown={onKeydown}
					>
						<span class="cmdk__row__label">
							{row.kind === 'cmd' ? row.item.label : row.item.title || 'Untitled thread'}
						</span>
						{#if row.kind === 'cmd' && row.item.hint}
							<span class="cmdk__row__hint">{row.item.hint}</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.cmdk {
		position: fixed; inset: 0;
		background: rgba(14, 14, 13, 0.5);
		display: grid; place-items: start center;
		padding-top: 12vh; z-index: 60;
		animation: cmdk-fade 120ms ease-out;
	}
	@media (prefers-reduced-motion: reduce) { .cmdk { animation: none; } }
	@keyframes cmdk-fade { from { opacity: 0; } to { opacity: 1; } }
	.cmdk__panel {
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		box-shadow: var(--shadow-3);
		width: 560px; max-width: calc(100vw - 32px); max-height: 70vh;
		display: flex; flex-direction: column; position: relative;
	}
	.cmdk__panel::before {
		content: ''; position: absolute;
		top: -1px; left: -1px; right: -1px; height: 2px;
		background: var(--ink-900);
	}
	.cmdk__input {
		border: 0; border-bottom: 1px solid var(--border-soft);
		background: transparent; font-family: var(--font-body);
		font-size: 15px; color: var(--fg-1);
		padding: 14px 16px; outline: none; width: 100%;
	}
	.cmdk__input::placeholder { color: var(--fg-3); }
	.cmdk__list { overflow-y: auto; padding: 6px 0 8px; min-height: 0; }
	.cmdk__section {
		font-family: var(--font-mono); font-size: 10.5px;
		text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--fg-3); padding: 10px 16px 4px;
	}
	.cmdk__row {
		display: flex; align-items: center; gap: 12px;
		padding: 8px 16px; cursor: pointer;
		color: var(--fg-1); font-size: 14px;
	}
	.cmdk__row--active { background: var(--bg-raised); }
	.cmdk__row__label {
		flex: 1; min-width: 0; overflow: hidden;
		text-overflow: ellipsis; white-space: nowrap;
	}
	.cmdk__row__hint {
		font-family: var(--font-mono); font-size: 10.5px;
		color: var(--fg-3); text-transform: uppercase; letter-spacing: 0.04em;
	}
	.cmdk__empty { padding: 20px 16px; color: var(--fg-3); font-size: 13px; }
</style>
