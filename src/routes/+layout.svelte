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
	import Rss from 'lucide-svelte/icons/rss';
	import MoreHorizontal from 'lucide-svelte/icons/more-horizontal';
	import Pin from 'lucide-svelte/icons/pin';
	import Plus from 'lucide-svelte/icons/plus';
	import Search from 'lucide-svelte/icons/search';
	import Activity from 'lucide-svelte/icons/activity';
	import KeyboardShortcuts from '$lib/components/KeyboardShortcuts.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import SystemPromptEditor from '$lib/components/SystemPromptEditor.svelte';
	import { groupByDate } from '$lib/utils/group-by-date';
	import { formatRelativeTime } from '$lib/utils/time';
	import { matchesAllTokens, searchTokens } from '$lib/utils/search-dedupe';
	import type { BoardChannel, OperatorFooterStatus } from '$lib/types';

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
	const sidebarMissions = $derived((data.channels ?? []) as BoardChannel[]);

	let paletteOpen = $state(false);
	let drawerOpen = $state(false);
	let isMobile = $state(false);
	let operatorStatus = $state<OperatorFooterStatus | null>(null);
	let operatorStatusLoading = $state(false);
	let operatorStatusError = $state<string | null>(null);

	// `now` snapshot for date-bucketing; refreshed on conversation list change so
	// labels don't drift mid-session without forcing a tight re-eval each tick.
	const groups = $derived(groupByDate(data.conversations as SidebarConvo[], Date.now()));

	function toggleDrawer() {
		drawerOpen = !drawerOpen;
	}

	function closeDrawer() {
		drawerOpen = false;
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
		const apply = () => (isMobile = mq.matches);
		apply();
		mq.addEventListener('change', apply);

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
			mq.removeEventListener('change', apply);
		};
	});

	function formatOperatorTime(value: string | null | undefined): string {
		if (!value) return 'Never';
		const parsed = Date.parse(value);
		if (!Number.isFinite(parsed)) return value;
		return formatRelativeTime(parsed);
	}

	function operatorMood(): 'ok' | 'warn' | 'error' {
		if (operatorStatus?.ok) return 'ok';
		if (operatorStatusLoading && !operatorStatus) return 'warn';
		return 'error';
	}

	function operatorHeadline(): string {
		if (operatorStatus?.ok) return 'Systems ready';
		if (operatorStatusLoading && !operatorStatus) return 'Checking systems';
		if (operatorStatusError) return 'Status unavailable';
		if (!operatorStatus?.gateway.ok || !operatorStatus?.hermes.available) return 'Needs attention';
		if (!operatorStatus?.dbBackup.ok) return 'Backup needs attention';
		return 'Needs attention';
	}

	function operatorMissionLine(): string {
		const lastRun = operatorStatus?.lastSuccessfulMissionRun;
		if (!lastRun) return 'Missions checking';
		if (!lastRun.at) return 'No completed missions yet';
		return `Last mission ${formatOperatorTime(lastRun.at)}`;
	}

	function operatorBackupLine(): string {
		const backup = operatorStatus?.dbBackup;
		if (!backup) return 'Backup checking';
		if (backup.latestAt) return `Backup ${formatOperatorTime(backup.latestAt)}`;
		return 'No backup yet';
	}

	function operatorJobsLine(): string {
		const count = operatorStatus?.pendingJobs.count;
		if (count === undefined) return 'Jobs checking';
		if (count === 0) return 'No jobs waiting';
		return count === 1 ? '1 job waiting' : `${count} jobs waiting`;
	}

	function operatorDetailTitle(): string {
		if (operatorStatusError) return operatorStatusError;
		if (!operatorStatus) return 'Collecting operator status';
		return [
			operatorStatus.gateway.detail,
			operatorStatus.hermes.detail,
			operatorStatus.dbBackup.detail
		]
			.filter(Boolean)
			.join('\n');
	}

	async function refreshOperatorStatus() {
		operatorStatusLoading = true;
		try {
			const response = await fetch('/api/operator/status', {
				headers: { accept: 'application/json' },
				cache: 'no-store'
			});
			if (!response.ok) throw new Error(`Operator status ${response.status}`);
			operatorStatus = (await response.json()) as OperatorFooterStatus;
			operatorStatusError = null;
		} catch (err) {
			operatorStatusError = err instanceof Error ? err.message : 'Unable to collect operator status';
		} finally {
			operatorStatusLoading = false;
		}
	}

	onMount(() => {
		void refreshOperatorStatus();
		const interval = window.setInterval(() => void refreshOperatorStatus(), 30_000);
		return () => window.clearInterval(interval);
	});

	let menuFor = $state<string | null>(null);
	let menuDirection = $state<'down' | 'up'>('down');
	let renamingFor = $state<string | null>(null);
	let renameDraft = $state('');
	let confirmDeleteFor = $state<string | null>(null);
	let confirmDeleteTimer: ReturnType<typeof setTimeout> | null = null;
	let missionMenuFor = $state<string | null>(null);
	let missionDeleteFor = $state<string | null>(null);
	let missionDeleteTimer: ReturnType<typeof setTimeout> | null = null;

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

	function closeChannelMenu() {
		missionMenuFor = null;
		if (missionDeleteTimer) {
			clearTimeout(missionDeleteTimer);
			missionDeleteTimer = null;
		}
		missionDeleteFor = null;
	}

	function openMenu(id: string, e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		closeChannelMenu();
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

	function openChannelMenu(jobId: string, e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		closeMenu();
		if (missionMenuFor === jobId) {
			closeChannelMenu();
			return;
		}
		missionMenuFor = jobId;
		missionDeleteFor = null;
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

	function armChannelDelete(jobId: string) {
		if (missionDeleteFor === jobId) return;
		missionDeleteFor = jobId;
		if (missionDeleteTimer) clearTimeout(missionDeleteTimer);
		missionDeleteTimer = setTimeout(() => {
			missionDeleteFor = null;
			missionDeleteTimer = null;
		}, 3000);
	}

	async function openChannelEditor(mission: BoardChannel, mode: 'rename' | 'edit') {
		closeChannelMenu();
		const target = new URL('/missions', window.location.origin);
		target.searchParams.set('mission', mission.slug);
		if (mode === 'rename') {
			target.searchParams.set('rename', '1');
		} else {
			target.searchParams.set('new', '1');
			target.searchParams.set('edit', '1');
		}
		await goto(target.toString(), { keepFocus: true, noScroll: true });
		onSelectThread();
	}

	async function confirmChannelDelete(mission: BoardChannel) {
		const jobId = (mission.jobId ?? '').trim();
		if (!jobId) return;
		closeChannelMenu();
		const response = await fetch(`/api/hermes/channels/${encodeURIComponent(jobId)}`, {
			method: 'DELETE'
		});
		if (!response.ok) {
			const text = await response.text();
			alert(text || 'Failed to delete mission.');
			return;
		}
		const active = page.url.pathname === '/missions' && page.url.searchParams.get('mission') === mission.slug;
		if (active) {
			await goto('/missions', { invalidateAll: true });
		} else {
			await invalidateAll();
		}
	}

	function onChannelRowAction(mission: BoardChannel) {
		const jobId = (mission.jobId ?? '').trim();
		if (!jobId) return;
		if (missionDeleteFor === jobId) {
			void confirmChannelDelete(mission);
			return;
		}
		armChannelDelete(jobId);
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
		if (missionMenuFor && t && !t.closest('[data-mission-row-menu]')) closeChannelMenu();
	}

	function onDocKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (menuFor) closeMenu();
		if (missionMenuFor) closeChannelMenu();
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

{#if onAuthPage || !data.user}
	{@render children()}
{:else}
	<div class="shell {drawerOpen ? 'shell--drawer-open' : ''}">
		<!-- Floating command bar — top-left, fixed, three icon buttons.
		     Hides when the drawer is open (drawer's own header has the toggle). -->
		<div class="cmdbar" role="toolbar" aria-label="App actions" data-hidden={drawerOpen}>
			<button
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
					onclick={toggleDrawer}
				>
					<PanelLeft size="15" strokeWidth={1.7} />
				</button>
				<a class="drawer__brand" href="/" aria-label="NewsCraft home" onclick={onSelectThread}>
					<span>NewsCraft</span>
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
				<a
					class="sidebar__primary-action sidebar__primary-action--channel"
					href="/missions?new=1"
					aria-label="New mission"
					title="Create mission"
					onclick={onSelectThread}
				>
					<Plus size="14" strokeWidth={1.8} />
					<span>New mission</span>
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
					<div class="sidebar__section">Missions</div>
					<a
						class="sidebar__row {page.url.pathname === '/missions' && !page.url.searchParams.get('mission')
							? 'sidebar__row--active'
							: ''}"
						href="/missions"
						aria-current={page.url.pathname === '/missions' && !page.url.searchParams.get('mission')
							? 'page'
							: undefined}
						onclick={onSelectThread}
					>
						<Rss class="sidebar__row__glyph" size="14" strokeWidth={1.5} />
						<span class="sidebar__row__name">All missions</span>
					</a>
					{#each sidebarMissions as mission (mission.slug)}
						{@const href = `/missions?mission=${encodeURIComponent(mission.slug)}`}
						{@const jobId = mission.jobId ?? ''}
						<div
							class="sidebar__row-wrap {page.url.pathname === '/missions' &&
							page.url.searchParams.get('mission') === mission.slug
								? 'sidebar__row-wrap--active'
								: ''}"
							data-mission-row-menu
						>
							<a
								class="sidebar__row {page.url.pathname === '/missions' &&
								page.url.searchParams.get('mission') === mission.slug
									? 'sidebar__row--active'
									: ''}"
								href={href}
								aria-current={page.url.pathname === '/missions' &&
								page.url.searchParams.get('mission') === mission.slug
									? 'page'
									: undefined}
								onclick={onSelectThread}
							>
								<Rss class="sidebar__row__glyph" size="14" strokeWidth={1.5} />
								<span class="sidebar__row__name">{mission.name}</span>
							</a>
							{#if jobId}
								<button
									type="button"
									class="sidebar__row-menu-btn"
									aria-label="Mission actions"
									aria-haspopup="menu"
									aria-expanded={missionMenuFor === jobId}
									onclick={(e) => openChannelMenu(jobId, e)}
								>
									<MoreHorizontal size="14" strokeWidth={1.8} />
								</button>
							{/if}
							{#if jobId && missionMenuFor === jobId}
								<div class="sidebar__menu" role="menu">
										<button type="button" role="menuitem" onclick={() => openChannelEditor(mission, 'rename')}>
											Edit name
									</button>
									<button type="button" role="menuitem" onclick={() => openChannelEditor(mission, 'edit')}>
										Edit mission
									</button>
									<button
										type="button"
										role="menuitem"
										class="sidebar__menu__danger"
										onclick={() => onChannelRowAction(mission)}
									>
										{missionDeleteFor === jobId ? 'Click again to confirm' : 'Delete mission'}
									</button>
								</div>
							{/if}
						</div>
					{:else}
						<div class="sidebar__row" style="color:var(--ink-400);cursor:default">
							<span class="sidebar__row__name">No missions yet</span>
						</div>
					{/each}
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
				<div class="operator-footer" title={operatorDetailTitle()} aria-label="Operator health status">
					<div class="operator-footer__head">
						<span class="operator-footer__title">
							<span class="operator-footer__dot operator-footer__dot--{operatorMood()}"></span>
							{operatorHeadline()}
						</span>
						<Activity size="13" strokeWidth={1.7} />
					</div>
					<div class="operator-footer__body">
						<span>{operatorMissionLine()}</span>
						<span>{operatorBackupLine()}</span>
						<span>{operatorJobsLine()}</span>
					</div>
				</div>
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

		<main class="pane {page.url.pathname.startsWith('/c/') ? 'pane--thread' : 'pane--plain'}">
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
