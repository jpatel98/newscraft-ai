<script lang="ts">
	import '$lib/styles/foundations.css';
	import '$lib/styles/components.css';

	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import Plus from 'lucide-svelte/icons/plus';
	import Settings from 'lucide-svelte/icons/settings';
	import LogOut from 'lucide-svelte/icons/log-out';
	import Hash from 'lucide-svelte/icons/hash';
	import MoreHorizontal from 'lucide-svelte/icons/more-horizontal';
	import Pin from 'lucide-svelte/icons/pin';
	import Search from 'lucide-svelte/icons/search';
	import KeyboardShortcuts from '$lib/components/KeyboardShortcuts.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';

	interface SidebarConvo {
		id: string;
		title: string;
		updatedAt: number;
		pinned: number;
	}

	let { children, data } = $props();

	const onLogin = $derived(page.url.pathname === '/login');

	let paletteOpen = $state(false);

	onMount(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
				e.preventDefault();
				paletteOpen = !paletteOpen;
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	});

	function relTime(ts: number): string {
		const ms = Date.now() - ts;
		const m = Math.floor(ms / 60_000);
		if (m < 1) return 'just now';
		if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h`;
		const d = Math.floor(h / 24);
		return `${d}d`;
	}

	let menuFor = $state<string | null>(null);
	let renamingFor = $state<string | null>(null);
	let renameDraft = $state('');
	let confirmDeleteFor = $state<string | null>(null);
	let confirmDeleteTimer: ReturnType<typeof setTimeout> | null = null;

	let renameInput = $state<HTMLInputElement | null>(null);

	function closeMenu() {
		menuFor = null;
		if (confirmDeleteTimer) {
			clearTimeout(confirmDeleteTimer);
			confirmDeleteTimer = null;
		}
		confirmDeleteFor = null;
	}

	function openMenu(id: string, e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		menuFor = menuFor === id ? null : id;
		confirmDeleteFor = null;
	}

	async function togglePin(c: SidebarConvo) {
		closeMenu();
		const next: 0 | 1 = c.pinned ? 0 : 1;
		await fetch(`/api/conversations/${c.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pinned: next })
		});
		await invalidateAll();
	}

	async function startRename(c: SidebarConvo) {
		closeMenu();
		renamingFor = c.id;
		renameDraft = c.title === '(untitled)' ? '' : c.title;
		await tick();
		renameInput?.focus();
		renameInput?.select();
	}

	async function commitRename(c: SidebarConvo) {
		const next = renameDraft.trim();
		if (!next || next.length > 200 || next === c.title) {
			renamingFor = null;
			return;
		}
		renamingFor = null;
		await fetch(`/api/conversations/${c.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: next })
		});
		await invalidateAll();
	}

	function cancelRename() {
		renamingFor = null;
		renameDraft = '';
	}

	function exportConvo(c: SidebarConvo, format: 'md' | 'jsonl') {
		closeMenu();
		const url = `/api/conversations/${c.id}/export?format=${format}`;
		const a = document.createElement('a');
		a.href = url;
		a.rel = 'noopener';
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	function armDelete(id: string) {
		if (confirmDeleteFor === id) return;
		confirmDeleteFor = id;
		if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
		confirmDeleteTimer = setTimeout(() => {
			confirmDeleteFor = null;
			confirmDeleteTimer = null;
		}, 3000);
	}

	async function confirmDelete(c: SidebarConvo) {
		closeMenu();
		const wasActive = page.params.id === c.id;
		await fetch(`/api/conversations/${c.id}`, { method: 'DELETE' });
		if (wasActive) {
			await goto('/', { invalidateAll: true });
		} else {
			await invalidateAll();
		}
	}

	function onRowAction(c: SidebarConvo) {
		if (confirmDeleteFor === c.id) {
			void confirmDelete(c);
		} else {
			armDelete(c.id);
		}
	}

	function onDocClick(e: MouseEvent) {
		if (!menuFor) return;
		const t = e.target as HTMLElement | null;
		if (t && t.closest('[data-row-menu]')) return;
		closeMenu();
	}

	function onDocKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && menuFor) {
			closeMenu();
		}
	}

	onMount(() => {
		window.addEventListener('click', onDocClick);
		window.addEventListener('keydown', onDocKeydown);
		return () => {
			window.removeEventListener('click', onDocClick);
			window.removeEventListener('keydown', onDocKeydown);
		};
	});

	interface SearchResult {
		conversationId: string;
		conversationTitle: string;
		messageId: string;
		role: 'user' | 'assistant' | 'system' | 'tool';
		snippet: string;
		createdAt: number;
	}

	let searchQ = $state('');
	let searchResults = $state<SearchResult[]>([]);
	let searchActive = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);
	let searchSeq = 0;
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	function escapeHtml(s: string): string {
		return s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	// Sanitise FTS5 snippets: escape everything, then re-promote the literal
	// `<mark>…</mark>` tokens the snippet() call wraps matches in. Only those
	// two tag forms are allowed back through.
	function sanitiseSnippet(raw: string): string {
		return escapeHtml(raw)
			.replace(/&lt;mark&gt;/g, '<mark>')
			.replace(/&lt;\/mark&gt;/g, '</mark>');
	}

	async function runSearch(q: string) {
		const seq = ++searchSeq;
		try {
			const res = await fetch('/api/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ q, limit: 20 })
			});
			if (seq !== searchSeq) return;
			if (!res.ok) {
				searchResults = [];
				return;
			}
			const data = (await res.json()) as { results: SearchResult[] };
			if (seq !== searchSeq) return;
			searchResults = data.results ?? [];
		} catch {
			if (seq !== searchSeq) return;
			searchResults = [];
		}
	}

	function onSearchInput() {
		const q = searchQ.trim();
		searchActive = q.length > 0;
		if (searchTimer) clearTimeout(searchTimer);
		if (!q) {
			searchResults = [];
			searchSeq++;
			return;
		}
		searchTimer = setTimeout(() => {
			void runSearch(q);
		}, 150);
	}

	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			searchQ = '';
			searchActive = false;
			searchResults = [];
			searchSeq++;
			searchInput?.focus();
		}
	}

	async function openResult(r: SearchResult) {
		const target = `/c/${r.conversationId}#m=${r.messageId}`;
		searchQ = '';
		searchActive = false;
		searchResults = [];
		await goto(target);
		await tick();
		const el = document.getElementById(`m-${r.messageId}`);
		if (el && typeof el.scrollIntoView === 'function') {
			el.scrollIntoView({ block: 'center' });
		}
	}
</script>

<svelte:head>
	<title>NewsCraft</title>
</svelte:head>

{#if onLogin || !data.user}
	{@render children()}
{:else}
	<div class="shell">
		<aside class="sidebar">
			<div class="sidebar__masthead">
				<a class="sidebar__brand" href="/" aria-label="NewsCraft home">
					<img src="/brand/logo-mark-inverse.svg" alt="" />
					<span>NewsCraft</span>
				</a>
				<a
					class="sidebar__action"
					href="/"
					aria-label="New chat"
					title="New chat (Cmd+Shift+O)"
				>
					<Plus size="14" strokeWidth={2} />
					<span>New</span>
				</a>
			</div>

			<div class="sidebar__search">
				<Search class="sidebar__search__glyph" size="13" strokeWidth={1.6} />
				<input
					bind:this={searchInput}
					bind:value={searchQ}
					oninput={onSearchInput}
					onkeydown={onSearchKeydown}
					type="text"
					class="sidebar__search__input"
					placeholder="Search messages"
					autocomplete="off"
					spellcheck="false"
					aria-label="Search messages"
				/>
			</div>

			{#if searchActive}
				<div class="sidebar__section">Results</div>
				<div class="sidebar__list" role="listbox" aria-label="Search results">
					{#if searchResults.length === 0}
						<div class="sidebar__row" style="color:var(--ink-400);cursor:default">
							<span class="sidebar__row__name">No matches</span>
						</div>
					{/if}
					{#each searchResults as r (r.messageId)}
						<button
							type="button"
							class="sidebar__hit"
							onclick={() => openResult(r)}
							role="option"
							aria-selected="false"
						>
							<div class="sidebar__hit__head">
								<span class="sidebar__hit__role">{r.role}</span>
								<span class="sidebar__hit__title">{r.conversationTitle || 'Untitled thread'}</span>
								<span class="sidebar__hit__time">{relTime(r.createdAt)}</span>
							</div>
							<div class="sidebar__hit__snippet">
								{@html sanitiseSnippet(r.snippet)}
							</div>
						</button>
					{/each}
				</div>
			{:else}
				<div class="sidebar__section">Threads</div>
				<div class="sidebar__list">
					{#if data.conversations.length === 0}
						<div class="sidebar__row" style="color:var(--ink-400);cursor:default">
							<span class="sidebar__row__name">No threads yet</span>
						</div>
					{/if}
					{#each data.conversations as c (c.id)}
						<div
							class="sidebar__row-wrap {page.params.id === c.id ? 'sidebar__row-wrap--active' : ''}"
							data-row-menu
						>
							{#if renamingFor === c.id}
								<div class="sidebar__row sidebar__row--editing">
									<Hash class="sidebar__row__glyph" size="14" strokeWidth={1.5} />
									<input
										bind:this={renameInput}
										bind:value={renameDraft}
										class="sidebar__rename"
										maxlength="200"
										onkeydown={(e) => {
											if (e.key === 'Enter') {
												e.preventDefault();
												void commitRename(c);
											} else if (e.key === 'Escape') {
												e.preventDefault();
												cancelRename();
											}
										}}
										onblur={() => commitRename(c)}
									/>
								</div>
							{:else}
								<a
									class="sidebar__row {page.params.id === c.id ? 'sidebar__row--active' : ''}"
									href={`/c/${c.id}`}
								>
									<Hash class="sidebar__row__glyph" size="14" strokeWidth={1.5} />
									{#if c.pinned}
										<Pin
											class="sidebar__row__pin"
											size="11"
											strokeWidth={1.8}
											fill="currentColor"
										/>
									{/if}
									<span class="sidebar__row__name">{c.title || 'Untitled thread'}</span>
									<span class="sidebar__row__time">{relTime(c.updatedAt)}</span>
								</a>
								<button
									type="button"
									class="sidebar__row-menu-btn"
									aria-label="Conversation actions"
									aria-haspopup="menu"
									aria-expanded={menuFor === c.id}
									onclick={(e) => openMenu(c.id, e)}
								>
									<MoreHorizontal size="14" strokeWidth={1.8} />
								</button>
							{/if}

							{#if menuFor === c.id}
								<div class="sidebar__menu" role="menu">
									<button type="button" role="menuitem" onclick={() => togglePin(c)}>
										{c.pinned ? 'Unpin' : 'Pin'}
									</button>
									<button type="button" role="menuitem" onclick={() => startRename(c)}>
										Rename
									</button>
									<button type="button" role="menuitem" onclick={() => exportConvo(c, 'md')}>
										Export Markdown
									</button>
									<button type="button" role="menuitem" onclick={() => exportConvo(c, 'jsonl')}>
										Export JSONL
									</button>
									<button
										type="button"
										role="menuitem"
										class="sidebar__menu__danger"
										onclick={() => onRowAction(c)}
									>
										{confirmDeleteFor === c.id ? 'Click again to confirm' : 'Delete'}
									</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<div class="sidebar__footer">
				<a href="/settings" aria-label="Settings">
					<Settings size="14" strokeWidth={1.5} style="vertical-align:-2px;margin-right:4px" />
					Settings
				</a>
				<form method="post" action="/logout" style="display:inline;margin-left:auto">
					<button type="submit" aria-label="Sign out">
						<LogOut size="14" strokeWidth={1.5} style="vertical-align:-2px;margin-right:4px" />
						Sign out
					</button>
				</form>
			</div>
		</aside>

		<main class="pane">
			{@render children()}
		</main>
	</div>
	<KeyboardShortcuts conversations={data.conversations} />
	<CommandPalette
		open={paletteOpen}
		conversations={data.conversations}
		onClose={() => (paletteOpen = false)}
	/>
{/if}
