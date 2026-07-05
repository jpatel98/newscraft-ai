<script lang="ts">
	import '$lib/styles/foundations.css';
	import '$lib/styles/components.css';

	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import PanelLeft from 'lucide-svelte/icons/panel-left';
	import SquarePen from 'lucide-svelte/icons/square-pen';
	import Sparkles from 'lucide-svelte/icons/sparkles';
	import Settings from 'lucide-svelte/icons/settings';
	import MessageSquare from 'lucide-svelte/icons/message-square';
	import MoreHorizontal from 'lucide-svelte/icons/more-horizontal';
	import Pin from 'lucide-svelte/icons/pin';
	import Search from 'lucide-svelte/icons/search';
	import KeyboardShortcuts from '$lib/components/KeyboardShortcuts.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import SystemPromptEditor from '$lib/components/SystemPromptEditor.svelte';
	import { groupByDate } from '$lib/utils/group-by-date';
	import { formatRelativeTime } from '$lib/utils/time';
	import { matchesAllTokens, searchTokens } from '$lib/utils/search-dedupe';

	interface SidebarConvo {
		id: string;
		title: string;
		updatedAt: number;
		pinned: number;
		systemPrompt: string | null;
	}

	let { children, data } = $props();

	const onAuthPage = $derived(
		page.url.pathname === '/login' ||
			page.url.pathname === '/signup' ||
			page.url.pathname === '/setup' ||
			page.url.pathname.startsWith('/account-setup')
	);
	const isThreadPage = $derived(page.url.pathname.startsWith('/c/'));

	let paletteOpen = $state(false);
	let drawerOpen = $state(false);
	let isMobile = $state(false);
	let drawerToggleButton = $state<HTMLButtonElement | null>(null);
	let keyboardOpen = $state(false);
	let visualViewportHeight = $state('100dvh');

	// `now` snapshot for date-bucketing; refreshed on conversation list change so
	// labels don't drift mid-session without forcing a tight re-eval each tick.
	const groups = $derived(groupByDate(data.conversations as SidebarConvo[], Date.now()));

	function toggleDrawer() {
		if (drawerOpen) {
			closeDrawer();
			return;
		}
		drawerOpen = true;
	}

	function closeDrawer() {
		drawerOpen = false;
		void tick().then(() => drawerToggleButton?.focus());
	}

	async function newChat() {
		await goto('/');
	}

	async function openDrawerForSearch() {
		drawerOpen = true;
		await tick();
		searchInput?.focus();
	}

	function onSelectThread() {
		if (isMobile) drawerOpen = false;
	}

	onMount(() => {
		const mq = window.matchMedia('(max-width: 760px)');

		const applyMobile = () => {
			isMobile = mq.matches;
			if (!isMobile) keyboardOpen = false;
		};
		const applyKeyboardState = () => {
			if (!isMobile) {
				keyboardOpen = false;
				visualViewportHeight = '100dvh';
				return;
			}
			if (!window.visualViewport) {
				keyboardOpen = false;
				visualViewportHeight = `${window.innerHeight}px`;
				return;
			}
			const keyboardHeight = Math.max(0, window.innerHeight - window.visualViewport.height);
			keyboardOpen = keyboardHeight > 130;
			visualViewportHeight = `${Math.round(window.visualViewport.height)}px`;
		};
		const onMediaChange = () => {
			applyMobile();
			applyKeyboardState();
		};
		const onViewportChange = () => {
			if (!window.visualViewport) return;
			applyKeyboardState();
		};

		applyMobile();
		applyKeyboardState();
		mq.addEventListener('change', onMediaChange);
		if (window.visualViewport) {
			window.visualViewport.addEventListener('resize', onViewportChange);
			window.visualViewport.addEventListener('scroll', onViewportChange);
		}

		const onOrientationChange = () => {
			applyMobile();
			applyKeyboardState();
		};
		window.addEventListener('orientationchange', onOrientationChange);
		void (async () => {
			if (!('serviceWorker' in navigator)) return;
			try {
				await navigator.serviceWorker.register('/service-worker.js');
			} catch {
				/* allow first-time registration failures without breaking runtime */
			}
		})();

		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
				e.preventDefault();
				paletteOpen = !paletteOpen;
				return;
			}
			if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B') && !e.shiftKey) {
				e.preventDefault();
				toggleDrawer();
				return;
			}
		};
		window.addEventListener('keydown', handler);

		return () => {
			window.removeEventListener('keydown', handler);
			mq.removeEventListener('change', onMediaChange);
			window.removeEventListener('orientationchange', onOrientationChange);
			if (window.visualViewport) {
				window.visualViewport.removeEventListener('resize', onViewportChange);
				window.visualViewport.removeEventListener('scroll', onViewportChange);
			}
		};
	});

	let menuFor = $state<string | null>(null);
	let menuDirection = $state<'down' | 'up'>('down');
	let renamingFor = $state<string | null>(null);
	let renameDraft = $state('');
	let confirmDeleteFor = $state<string | null>(null);
	let confirmDeleteTimer: ReturnType<typeof setTimeout> | null = null;
	let titleRetryBusyFor = $state<string | null>(null);

	let renameInput = $state<HTMLInputElement | null>(null);

	function closeMenu() {
		menuFor = null;
		menuDirection = 'down';
		if (confirmDeleteTimer) {
			clearTimeout(confirmDeleteTimer);
			confirmDeleteTimer = null;
		}
		confirmDeleteFor = null;
	}

	function openMenu(id: string, e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (menuFor === id) {
			closeMenu();
			return;
		}

		const trigger = e.currentTarget as HTMLElement | null;
		const row = trigger?.closest('[data-row-menu]') as HTMLElement | null;
		const list = trigger?.closest('.sidebar__list') as HTMLElement | null;

		menuDirection = 'down';
		if (row && list) {
			const rowRect = row.getBoundingClientRect();
			const listRect = list.getBoundingClientRect();
			const estimatedMenuHeight = 260;
			const gap = 8;
			const below = listRect.bottom - rowRect.bottom - gap;
			const above = rowRect.top - listRect.top - gap;

			if (below < estimatedMenuHeight && above > below) {
				menuDirection = 'up';
			}
		}

		menuFor = id;
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

	function canRetryTitle(c: SidebarConvo): boolean {
		const title = c.title.trim().toLowerCase();
		return (
			(!title || title === '(untitled)' || title === 'new chat') &&
			Date.now() - c.updatedAt > 60_000
		);
	}

	async function retryTitle(c: SidebarConvo) {
		if (titleRetryBusyFor) return;
		closeMenu();
		titleRetryBusyFor = c.id;
		try {
			const response = await fetch(`/api/conversations/${c.id}/title`, { method: 'POST' });
			if (!response.ok) throw new Error(await response.text());
			await invalidateAll();
		} catch (err) {
			console.warn('NewsCraft title retry failed', err);
			alert('Could not retry the title.');
		} finally {
			titleRetryBusyFor = null;
		}
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

	let systemPromptFor = $state<string | null>(null);
	const systemPromptConvo = $derived(
		systemPromptFor ? data.conversations.find((c) => c.id === systemPromptFor) ?? null : null
	);

	function openSystemPrompt(c: SidebarConvo) {
		closeMenu();
		systemPromptFor = c.id;
	}

	function onDocClick(e: MouseEvent) {
		const t = e.target as HTMLElement | null;
		if (menuFor && t && !t.closest('[data-row-menu]')) closeMenu();
	}

	function onDocKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (menuFor) closeMenu();
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
		role: 'user' | 'assistant' | 'system' | 'tool' | 'thread';
		snippet: string;
		createdAt: number;
	}

	let searchQ = $state('');
	let searchResults = $state<SearchResult[]>([]);
	let searchActive = $state(false);
	let searchLoading = $state(false);
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

	function markLocalSnippet(text: string, tokens: string[]): string {
		const escaped = escapeHtml(text || 'Untitled thread');
		if (tokens.length === 0) return escaped;
		const pattern = new RegExp(
			`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
			'gi'
		);
		return escaped.replace(pattern, '<mark>$1</mark>');
	}

	function localTitleResults(q: string): SearchResult[] {
		const tokens = searchTokens(q);
		if (tokens.length === 0) return [];
		return (data.conversations as SidebarConvo[])
			.filter((c) => matchesAllTokens(c.title || '(untitled)', tokens))
			.slice(0, 20)
			.map((c) => ({
				conversationId: c.id,
				conversationTitle: c.title || '(untitled)',
				messageId: '',
				role: 'thread',
				snippet: markLocalSnippet(c.title || '(untitled)', tokens),
				createdAt: c.updatedAt
			}));
	}

	async function runSearch(q: string) {
		const seq = ++searchSeq;
		searchLoading = true;
		try {
			const res = await fetch('/api/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ q, limit: 20 })
			});
			if (seq !== searchSeq) return;
			searchLoading = false;
			if (!res.ok) {
				searchResults = localTitleResults(q);
				return;
			}
			const data = (await res.json()) as { results: SearchResult[] };
			if (seq !== searchSeq) return;
			searchResults = data.results?.length ? data.results : localTitleResults(q);
		} catch {
			if (seq !== searchSeq) return;
			searchLoading = false;
			searchResults = localTitleResults(q);
		}
	}

	function onSearchInput() {
		const q = searchQ.trim();
		searchActive = q.length > 0;
		if (searchTimer) clearTimeout(searchTimer);
		if (!q) {
			searchResults = [];
			searchSeq++;
			searchLoading = false;
			return;
		}
		searchResults = localTitleResults(q);
		searchLoading = true;
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
			searchLoading = false;
			searchInput?.focus();
		}
	}

	async function openResult(r: SearchResult) {
		const target = r.messageId ? `/c/${r.conversationId}#m=${r.messageId}` : `/c/${r.conversationId}`;
		searchQ = '';
		searchActive = false;
		searchResults = [];
		searchLoading = false;
		await goto(target);
		await tick();
		const el = r.messageId ? document.getElementById(`m-${r.messageId}`) : null;
		if (el) {
			el.scrollIntoView({ block: 'center' });
		}
		onSelectThread();
	}
</script>

<svelte:head>
	<title>NewsCraft</title>
</svelte:head>

{#if onAuthPage || data.isMarketingHost || !data.user}
	{@render children()}
{:else}
	<div
		class="shell {drawerOpen ? 'shell--drawer-open' : ''} {isThreadPage ? 'shell--thread' : 'shell--plain'}"
		data-keyboard-open={keyboardOpen ? 'true' : 'false'}
		style={`--visual-vh: ${visualViewportHeight};`}
	>
		<!-- Floating command bar — top-left, fixed, three icon buttons.
		     Hides when the drawer is open (drawer's own header has the toggle). -->
		<div class="cmdbar" role="toolbar" aria-label="App actions" data-hidden={drawerOpen}>
			<button
				bind:this={drawerToggleButton}
				type="button"
				class="cmdbar__btn"
				aria-label="Toggle sidebar"
				aria-expanded={drawerOpen}
				title="Toggle sidebar (Cmd+B)"
				onclick={toggleDrawer}
			>
				<PanelLeft size="16" strokeWidth={1.7} />
			</button>
			<button
				type="button"
				class="cmdbar__btn"
				aria-label="Search threads"
				title="Search threads"
				onclick={openDrawerForSearch}
			>
				<Search size="16" strokeWidth={1.7} />
			</button>
			<button
				type="button"
				class="cmdbar__btn"
				aria-label="New chat"
				title="New chat (Cmd+Shift+O)"
				onclick={newChat}
			>
				<SquarePen size="16" strokeWidth={1.7} />
			</button>
		</div>

		{#if drawerOpen && isMobile}
			<button
				type="button"
				class="drawer__backdrop"
				aria-label="Close sidebar"
				onclick={closeDrawer}
			></button>
		{/if}

		<aside
			class="drawer {drawerOpen ? 'drawer--open' : ''}"
			aria-label="Sidebar"
			aria-hidden={!drawerOpen}
			inert={!drawerOpen}
		>
			<div class="drawer__head">
				<button
					type="button"
					class="drawer__head__btn"
					aria-label="Close sidebar"
					onclick={closeDrawer}
				>
					<PanelLeft size="15" strokeWidth={1.7} />
				</button>
				<a class="drawer__brand" href="/" aria-label="NewsCraft home" onclick={onSelectThread}>
					<span class="drawer__brand__full">NewsCraft</span>
					<span class="drawer__brand__compact">NC</span>
				</a>
				<span class="drawer__head__btn drawer__head__btn--static" aria-hidden="true">
					<Sparkles size="15" strokeWidth={1.7} />
				</span>
			</div>

			<div class="drawer__quick-actions">
				<a
					class="sidebar__primary-action sidebar__primary-action--chat"
					href="/"
					aria-label="New chat"
					title="New chat (Cmd+Shift+O)"
					onclick={onSelectThread}
				>
					<SquarePen size="14" strokeWidth={1.8} />
					<span>New chat</span>
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
					placeholder="Search your threads..."
					autocomplete="off"
					spellcheck="false"
					aria-label="Search your threads"
				/>
			</div>

			<div class="drawer__divider" aria-hidden="true"></div>

			{#if searchActive}
				<div class="sidebar__section">Results</div>
				<div class="sidebar__list" role="listbox" aria-label="Search results">
					{#if searchResults.length === 0 && searchLoading}
						<div class="sidebar__row" style="color:var(--ink-400);cursor:default">
							<span class="sidebar__row__name">Searching…</span>
						</div>
					{:else if searchResults.length === 0}
						<div class="sidebar__row" style="color:var(--ink-400);cursor:default">
							<span class="sidebar__row__name">No matches</span>
						</div>
					{/if}
					{#each searchResults as r (`${r.conversationId}:${r.messageId || 'thread'}:${r.role}`)}
						<button
							type="button"
							class="sidebar__hit"
							onclick={() => openResult(r)}
							role="option"
							aria-selected="false"
						>
							<div class="sidebar__hit__head">
								<span class="sidebar__hit__role">{r.role === 'thread' ? 'thread' : r.role}</span>
								<span class="sidebar__hit__title">{r.conversationTitle || 'Untitled thread'}</span>
								<span class="sidebar__hit__time">{formatRelativeTime(r.createdAt)}</span>
							</div>
							<div class="sidebar__hit__snippet">
								{@html sanitiseSnippet(r.snippet)}
							</div>
						</button>
					{/each}
				</div>
				{:else}
					<div class="sidebar__list">
						<div class="sidebar__section">Chats</div>
					{#if data.conversations.length === 0}
						<div class="sidebar__row" style="color:var(--ink-400);cursor:default">
							<span class="sidebar__row__name">No chats yet</span>
						</div>
					{/if}

					{#each [['PINNED', groups.pinned], ['TODAY', groups.today], ['YESTERDAY', groups.yesterday], ['LAST 7 DAYS', groups.last7], ['EARLIER', groups.earlier]] as const as [label, items] (label)}
						{#if items.length > 0}
							<div class="sidebar__subsection">{label}</div>
							{#each items as c (c.id)}
								<div
									class="sidebar__row-wrap {page.params.id === c.id
										? 'sidebar__row-wrap--active'
										: ''}"
									data-row-menu
								>
									{#if renamingFor === c.id}
										<div class="sidebar__row sidebar__row--editing">
											<MessageSquare class="sidebar__row__glyph" size="14" strokeWidth={1.5} />
											<input
												bind:this={renameInput}
												bind:value={renameDraft}
												class="sidebar__rename"
												aria-label="Thread title"
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
											/>
											<button
												type="button"
												class="sidebar__rename-btn"
												onclick={() => commitRename(c)}
											>
												Save
											</button>
											<button type="button" class="sidebar__rename-btn" onclick={cancelRename}>
												Cancel
											</button>
										</div>
									{:else}
										<a
											class="sidebar__row {page.params.id === c.id ? 'sidebar__row--active' : ''}"
											href={`/c/${c.id}`}
											onclick={onSelectThread}
										>
											<MessageSquare class="sidebar__row__glyph" size="14" strokeWidth={1.5} />
											{#if c.pinned}
												<Pin
													class="sidebar__row__pin"
													size="11"
													strokeWidth={1.8}
													fill="currentColor"
												/>
											{/if}
											<span class="sidebar__row__name">{c.title || 'Untitled thread'}</span>
											<span class="sidebar__row__time">{formatRelativeTime(c.updatedAt)}</span>
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
										<div
											class="sidebar__menu {menuDirection === 'up' ? 'sidebar__menu--up' : ''}"
											role="menu"
										>
											<button type="button" role="menuitem" onclick={() => togglePin(c)}>
												{c.pinned ? 'Unpin' : 'Pin'}
											</button>
											{#if canRetryTitle(c)}
												<button
													type="button"
													role="menuitem"
													disabled={titleRetryBusyFor === c.id}
													onclick={() => retryTitle(c)}
												>
													{titleRetryBusyFor === c.id ? 'Retrying title' : 'Retry title'}
												</button>
											{/if}
											<button type="button" role="menuitem" onclick={() => startRename(c)}>
												Rename
											</button>
											<button type="button" role="menuitem" onclick={() => openSystemPrompt(c)}>
												System prompt{c.systemPrompt ? ' •' : ''}
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
						{/if}
					{/each}
				</div>
			{/if}

			<div class="sidebar__footer">
				<a
					href="/settings"
					class="sidebar__footer-link {page.url.pathname === '/settings'
						? 'sidebar__footer-link--active'
						: ''}"
					aria-label="Settings"
					aria-current={page.url.pathname === '/settings' ? 'page' : undefined}
					onclick={onSelectThread}
				>
					<Settings size="14" strokeWidth={1.5} />
					<span>Settings</span>
				</a>
			</div>
		</aside>

		<main class="pane {isThreadPage ? 'pane--thread' : 'pane--plain'}">
			{@render children()}
		</main>
	</div>
	<KeyboardShortcuts conversations={data.conversations} />
	<CommandPalette
		open={paletteOpen}
		conversations={data.conversations}
		onClose={() => (paletteOpen = false)}
	/>
	{#if systemPromptConvo}
		<SystemPromptEditor
			conversationId={systemPromptConvo.id}
			initial={systemPromptConvo.systemPrompt}
			open={true}
			onClose={() => (systemPromptFor = null)}
		/>
	{/if}
{/if}
