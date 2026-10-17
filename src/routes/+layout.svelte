<script lang="ts">
	import '$lib/styles/foundations.css';
	import '$lib/styles/components.css';

	import { onMount, tick } from 'svelte';
	import { page, navigating } from '$app/state';
	import { goto, invalidate, invalidateAll } from '$app/navigation';
	import PanelLeft from 'lucide-svelte/icons/panel-left';
	import SquarePen from 'lucide-svelte/icons/square-pen';
	import Sparkles from 'lucide-svelte/icons/sparkles';
	import Settings from 'lucide-svelte/icons/settings';
	import MessageSquare from 'lucide-svelte/icons/message-square';
	import MoreHorizontal from 'lucide-svelte/icons/more-horizontal';
	import Pin from 'lucide-svelte/icons/pin';
	import Search from 'lucide-svelte/icons/search';
	import Folder from 'lucide-svelte/icons/folder';
	import FolderOpen from 'lucide-svelte/icons/folder-open';
	import FolderPlus from 'lucide-svelte/icons/folder-plus';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import KeyboardShortcuts from '$lib/components/KeyboardShortcuts.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import SystemPromptEditor from '$lib/components/SystemPromptEditor.svelte';
	import { groupByDate } from '$lib/utils/group-by-date';
	import { formatRelativeTime } from '$lib/utils/time';
	import { matchesAllTokens, searchTokens } from '$lib/utils/search-dedupe';
	import { CONVERSATIONS_DEPENDENCY } from '$lib/utils/load-dependencies';

	interface SidebarConvo {
		id: string;
		title: string;
		updatedAt: number;
		pinned: number;
		systemPrompt: string | null;
		folderId: string | null;
	}

	interface SidebarFolder {
		id: string;
		name: string;
		count: number;
	}

	let { children, data } = $props();

	const onAuthPage = $derived(
		page.url.pathname === '/login' ||
			page.url.pathname === '/signup' ||
			page.url.pathname === '/setup' ||
			page.url.pathname.startsWith('/account-setup')
	);
	const isThreadPage = $derived(page.url.pathname.startsWith('/c/') && !page.url.pathname.endsWith('/project'));

	let paletteOpen = $state(false);
	let shellReady = $state(false);
	let drawerOpen = $state(false);
	let isMobile = $state(false);
	let drawerToggleButton = $state<HTMLButtonElement | null>(null);
	let keyboardOpen = $state(false);
	let visualViewportHeight = $state('100dvh');
	let visualViewportOffsetTop = $state('0px');

	// `now` snapshot for date-bucketing; refreshed on conversation list change so
	// labels don't drift mid-session without forcing a tight re-eval each tick.
	const folders = $derived((data.folders ?? []) as SidebarFolder[]);
	const folderChats = $derived.by(() => {
		const byFolder = new Map<string, SidebarConvo[]>(folders.map((f) => [f.id, []]));
		for (const c of data.conversations as SidebarConvo[]) {
			if (c.folderId) byFolder.get(c.folderId)?.push(c);
		}
		for (const chats of byFolder.values()) chats.sort((a, b) => b.updatedAt - a.updatedAt);
		return byFolder;
	});
	// Filed chats live under their folder, so the dated list only shows unfiled ones.
	const unfiled = $derived(
		(data.conversations as SidebarConvo[]).filter((c) => !c.folderId || !folderChats.has(c.folderId))
	);
	const groups = $derived(groupByDate(unfiled, Date.now()));

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
		let restingViewportHeight = 0;

		const applyMobile = () => {
			isMobile = mq.matches;
			if (!isMobile) {
				keyboardOpen = false;
				visualViewportHeight = '100dvh';
				visualViewportOffsetTop = '0px';
			}
		};
		const applyKeyboardState = () => {
			if (!isMobile) {
				keyboardOpen = false;
				visualViewportHeight = '100dvh';
				visualViewportOffsetTop = '0px';
				return;
			}
			if (!window.visualViewport) {
				keyboardOpen = false;
				visualViewportHeight = `${window.innerHeight}px`;
				visualViewportOffsetTop = '0px';
				return;
			}
			const viewport = window.visualViewport;
			const activeElement = document.activeElement;
			const editableFocused =
				activeElement instanceof HTMLInputElement ||
				activeElement instanceof HTMLTextAreaElement ||
				activeElement instanceof HTMLSelectElement ||
				(activeElement instanceof HTMLElement && activeElement.isContentEditable);
			// Keep the last full resting viewport as the keyboard baseline. Mobile
			// browser chrome can make innerHeight and dvh disagree, especially in
			// SFSafariViewController, so their difference is not reliable evidence
			// that the keyboard is open.
			if (!editableFocused && viewport.scale <= 1.05) {
				restingViewportHeight = Math.max(restingViewportHeight, viewport.height);
			}
			const keyboardHeight = Math.max(0, restingViewportHeight - viewport.height);
			keyboardOpen = editableFocused && keyboardHeight > 130;

			// VisualViewport is the only mobile measurement that includes both
			// browser-chrome movement and the on-screen keyboard. Height alone is
			// insufficient: iOS can scroll the visual viewport down to keep a
			// focused field visible. Preserve that origin so the shell fills the
			// exact visible rectangle instead of leaving a dead strip below it.
			visualViewportHeight = `${Math.max(1, Math.round(viewport.height))}px`;
			visualViewportOffsetTop = `${Math.max(0, Math.round(viewport.offsetTop))}px`;
		};
		const onMediaChange = () => {
			applyMobile();
			applyKeyboardState();
		};
		const onViewportChange = () => {
			if (!window.visualViewport) return;
			applyKeyboardState();
		};
		const onFocusChange = () => {
			requestAnimationFrame(applyKeyboardState);
		};

		applyMobile();
		applyKeyboardState();
		mq.addEventListener('change', onMediaChange);
		if (window.visualViewport) {
			window.visualViewport.addEventListener('resize', onViewportChange);
			window.visualViewport.addEventListener('scroll', onViewportChange);
		}
		window.addEventListener('focusin', onFocusChange);
		window.addEventListener('focusout', onFocusChange);

		const onOrientationChange = () => {
			restingViewportHeight = 0;
			requestAnimationFrame(() => {
				applyMobile();
				applyKeyboardState();
			});
		};
		window.addEventListener('orientationchange', onOrientationChange);
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
		shellReady = true;

		return () => {
			shellReady = false;
			window.removeEventListener('keydown', handler);
			mq.removeEventListener('change', onMediaChange);
			window.removeEventListener('orientationchange', onOrientationChange);
			if (window.visualViewport) {
				window.visualViewport.removeEventListener('resize', onViewportChange);
				window.visualViewport.removeEventListener('scroll', onViewportChange);
			}
			window.removeEventListener('focusin', onFocusChange);
			window.removeEventListener('focusout', onFocusChange);
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
		moveMenuFor = null;
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
		moveMenuFor = null;
	}

	async function togglePin(c: SidebarConvo) {
		closeMenu();
		const next: 0 | 1 = c.pinned ? 0 : 1;
		await fetch(`/api/conversations/${c.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pinned: next })
		});
		await invalidate(CONVERSATIONS_DEPENDENCY);
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
		await invalidate(CONVERSATIONS_DEPENDENCY);
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

	// ---------- Folders ----------
	const OPEN_FOLDERS_KEY = 'newscraft:open-folders';
	let openFolders = $state<Record<string, boolean>>({});
	let creatingFolder = $state(false);
	let folderDraft = $state('');
	let folderInput = $state<HTMLInputElement | null>(null);
	let moveAfterCreate = $state<string | null>(null);
	let folderRenamingFor = $state<string | null>(null);
	let folderBusy = $state(false);
	let moveMenuFor = $state<string | null>(null);
	let dragChatId = $state<string | null>(null);
	let dropTarget = $state<string | null>(null);

	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) ?? '{}');
			if (saved && typeof saved === 'object') openFolders = saved;
		} catch {
			// Folder open state is a convenience; start collapsed without it.
		}
	});

	function isFolderOpen(f: SidebarFolder, chats: SidebarConvo[]): boolean {
		if (openFolders[f.id] !== undefined) return openFolders[f.id];
		return chats.some((c) => c.id === page.params.id);
	}

	function setFolderOpen(id: string, open: boolean) {
		openFolders = { ...openFolders, [id]: open };
		try {
			localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify(openFolders));
		} catch {
			// Ignore storage failures (private mode, quota).
		}
	}

	async function refreshFolders() {
		await Promise.all([invalidate(CONVERSATIONS_DEPENDENCY), invalidate('app:projects')]);
	}

	async function startCreateFolder(moveChatId: string | null = null) {
		closeMenu();
		folderRenamingFor = null;
		creatingFolder = true;
		folderDraft = '';
		moveAfterCreate = moveChatId;
		await tick();
		folderInput?.focus();
	}

	async function startRenameFolder(f: SidebarFolder) {
		closeMenu();
		creatingFolder = false;
		folderRenamingFor = f.id;
		folderDraft = f.name;
		await tick();
		folderInput?.focus();
		folderInput?.select();
	}

	function cancelFolderEdit() {
		creatingFolder = false;
		folderRenamingFor = null;
		folderDraft = '';
		moveAfterCreate = null;
	}

	async function commitFolderEdit(e?: SubmitEvent) {
		e?.preventDefault();
		const name = folderDraft.trim();
		if (folderBusy) return;
		if (!name || name.length > 100) {
			if (!name) cancelFolderEdit();
			return;
		}
		folderBusy = true;
		try {
			if (folderRenamingFor) {
				const id = folderRenamingFor;
				const current = folders.find((f) => f.id === id);
				if (current && current.name !== name) {
					const res = await fetch(`/api/projects/${id}`, {
						method: 'PATCH',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name })
					});
					if (!res.ok) throw new Error(await res.text());
				}
			} else {
				const res = await fetch('/api/projects', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name })
				});
				if (!res.ok) throw new Error(await res.text());
				const created = (await res.json()) as { id: string };
				setFolderOpen(created.id, true);
				if (moveAfterCreate) await moveChat(moveAfterCreate, created.id, false);
			}
			cancelFolderEdit();
			await refreshFolders();
		} catch (err) {
			console.warn('NewsCraft folder save failed', err);
			alert('Could not save the folder. Try again.');
		} finally {
			folderBusy = false;
		}
	}

	async function deleteFolder(f: SidebarFolder) {
		closeMenu();
		const res = await fetch(`/api/projects/${f.id}`, { method: 'DELETE' });
		if (!res.ok) {
			alert('Could not delete the folder.');
			return;
		}
		const { [f.id]: _removed, ...rest } = openFolders;
		openFolders = rest;
		if (page.url.pathname === `/projects/${f.id}`) {
			await goto('/', { invalidateAll: true });
		} else {
			await refreshFolders();
		}
	}

	function onFolderDeleteAction(f: SidebarFolder) {
		const key = `folder:${f.id}`;
		if (confirmDeleteFor === key) {
			void deleteFolder(f);
		} else {
			armDelete(key);
		}
	}

	async function moveChat(chatId: string, folderId: string | null, refresh = true) {
		closeMenu();
		const res = await fetch(`/api/conversations/${chatId}/project`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: folderId })
		});
		if (!res.ok) {
			alert('Could not move the chat.');
			return;
		}
		if (folderId) setFolderOpen(folderId, true);
		if (refresh) await refreshFolders();
	}

	function onChatDragStart(c: SidebarConvo, e: DragEvent) {
		dragChatId = c.id;
		e.dataTransfer?.setData('text/plain', c.id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}

	function onChatDragEnd() {
		dragChatId = null;
		dropTarget = null;
	}

	function onDropTargetOver(target: string, e: DragEvent) {
		if (!dragChatId) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropTarget = target;
	}

	function onDropTargetLeave(target: string, e: DragEvent) {
		const next = e.relatedTarget as Node | null;
		if (next && (e.currentTarget as HTMLElement).contains(next)) return;
		if (dropTarget === target) dropTarget = null;
	}

	function onDropOnTarget(folderId: string | null, e: DragEvent) {
		if (!dragChatId) return;
		e.preventDefault();
		const chat = (data.conversations as SidebarConvo[]).find((c) => c.id === dragChatId);
		dragChatId = null;
		dropTarget = null;
		if (!chat || (chat.folderId ?? null) === folderId) return;
		void moveChat(chat.id, folderId);
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
		// composedPath is fixed at dispatch, so a menu item that re-rendered the
		// menu (like "Move to folder" opening its folder list) still counts as inside.
		const insideMenu = e
			.composedPath()
			.some((el) => el instanceof HTMLElement && el.hasAttribute('data-row-menu'));
		if (menuFor && !insideMenu) closeMenu();
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
	let searchList = $state<HTMLDivElement | null>(null);
	let searchActiveIndex = $state(-1);
	let searchSeq = 0;
	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	const searchListboxId = 'sidebar-search-results';

	function searchOptionId(i: number): string {
		return `sidebar-search-result-${i}`;
	}

	function setSearchResults(next: SearchResult[]) {
		searchResults = next;
		searchActiveIndex = next.length > 0 ? 0 : -1;
	}

	function clearSearch() {
		if (searchTimer) {
			clearTimeout(searchTimer);
			searchTimer = null;
		}
		searchQ = '';
		searchActive = false;
		searchResults = [];
		searchActiveIndex = -1;
		searchSeq++;
		searchLoading = false;
	}

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
				setSearchResults(localTitleResults(q));
				return;
			}
			const data = (await res.json()) as { results: SearchResult[] };
			if (seq !== searchSeq) return;
			setSearchResults(data.results?.length ? data.results : localTitleResults(q));
		} catch {
			if (seq !== searchSeq) return;
			searchLoading = false;
			setSearchResults(localTitleResults(q));
		}
	}

	function onSearchInput() {
		const q = searchQ.trim();
		searchActive = q.length > 0;
		if (searchTimer) clearTimeout(searchTimer);
		if (!q) {
			searchResults = [];
			searchActiveIndex = -1;
			searchSeq++;
			searchLoading = false;
			return;
		}
		setSearchResults(localTitleResults(q));
		searchLoading = true;
		searchTimer = setTimeout(() => {
			void runSearch(q);
		}, 150);
	}

	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			clearSearch();
			searchInput?.focus();
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (searchResults.length > 0) {
				searchActiveIndex = (searchActiveIndex + 1) % searchResults.length;
			}
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (searchResults.length > 0) {
				searchActiveIndex =
					searchActiveIndex <= 0 ? searchResults.length - 1 : searchActiveIndex - 1;
			}
			return;
		}
		if (e.key === 'Enter') {
			const activeResult = searchResults[searchActiveIndex >= 0 ? searchActiveIndex : 0];
			if (activeResult) {
				e.preventDefault();
				void openResult(activeResult);
			}
		}
	}

	async function openResult(r: SearchResult) {
		const target = r.messageId ? `/c/${r.conversationId}#m=${r.messageId}` : `/c/${r.conversationId}`;
		searchQ = '';
		searchActive = false;
		searchResults = [];
		searchActiveIndex = -1;
		searchLoading = false;
		await goto(target);
		await tick();
		const el = r.messageId ? document.getElementById(`m-${r.messageId}`) : null;
		if (el) {
			el.scrollIntoView({ block: 'center' });
		}
		onSelectThread();
	}

	$effect(() => {
		if (!searchList || searchActiveIndex < 0) return;
		searchList
			.querySelector<HTMLElement>(`[data-search-i="${searchActiveIndex}"]`)
			?.scrollIntoView({ block: 'nearest' });
	});
</script>

<svelte:head>
	<title>NewsCraft</title>
</svelte:head>

{#if onAuthPage || data.isMarketingHost || !data.user}
	{@render children()}
{:else}
	<div
		class="shell {drawerOpen ? 'shell--drawer-open' : ''} {isThreadPage ? 'shell--thread' : 'shell--plain'}"
		data-ready={shellReady ? 'true' : 'false'}
		data-keyboard-open={keyboardOpen ? 'true' : 'false'}
		style={`--visual-vh: ${visualViewportHeight}; --visual-offset-top: ${visualViewportOffsetTop};`}
	>
		<!-- Floating command bar — top-left, three icon buttons.
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
				class="cmdbar__btn cmdbar__btn--search"
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
					NewsCraft
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
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={searchActive}
					aria-controls={searchActive ? searchListboxId : undefined}
					aria-activedescendant={searchActive && searchActiveIndex >= 0
						? searchOptionId(searchActiveIndex)
						: undefined}
				/>
			</div>

			<div class="drawer__divider" aria-hidden="true"></div>

			{#if searchActive}
				<div class="sidebar__section">Results</div>
				<div
					id={searchListboxId}
					bind:this={searchList}
					class="sidebar__list"
					role="listbox"
					aria-label="Search results"
				>
					{#if searchResults.length === 0 && searchLoading}
						<div class="sidebar__row" style="color:var(--ink-400);cursor:default">
							<span class="sidebar__row__name">Searching…</span>
						</div>
					{:else if searchResults.length === 0}
						<div class="sidebar__row" style="color:var(--ink-400);cursor:default">
							<span class="sidebar__row__name">No matches</span>
						</div>
					{/if}
					{#each searchResults as r, i (`${r.conversationId}:${r.messageId || 'thread'}:${r.role}`)}
						<button
							id={searchOptionId(i)}
							type="button"
							class="sidebar__hit {i === searchActiveIndex ? 'sidebar__hit--active' : ''}"
							data-search-i={i}
							onclick={() => openResult(r)}
							onmousemove={() => (searchActiveIndex = i)}
							role="option"
							aria-selected={i === searchActiveIndex}
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
						<div class="sidebar__section sidebar__section--with-action">
							<span>Folders</span>
							<button
								type="button"
								class="sidebar__section-btn"
								aria-label="New folder"
								title="New folder"
								onclick={() => startCreateFolder()}
							>
								<FolderPlus size="13" strokeWidth={1.8} />
							</button>
						</div>
						{#if creatingFolder}
							{@render folderEditor('Create')}
						{:else if folders.length === 0}
							<button type="button" class="sidebar__folder-hint" onclick={() => startCreateFolder()}>
								Group related chats into folders
							</button>
						{/if}
						{#each folders as f (f.id)}
							{@const chats = folderChats.get(f.id) ?? []}
							{@const open = isFolderOpen(f, chats)}
							<div
								class="sidebar__row-wrap sidebar__folder {dropTarget === f.id ? 'sidebar__folder--drop' : ''}"
								data-row-menu
								role="group"
								aria-label={`Folder ${f.name}`}
								ondragover={(e) => onDropTargetOver(f.id, e)}
								ondragleave={(e) => onDropTargetLeave(f.id, e)}
								ondrop={(e) => onDropOnTarget(f.id, e)}
							>
								{#if folderRenamingFor === f.id}
									{@render folderEditor('Save')}
								{:else}
									<button
										type="button"
										class="sidebar__row sidebar__folder-row"
										aria-expanded={open}
										onclick={() => setFolderOpen(f.id, !open)}
									>
										<ChevronRight
											class="sidebar__folder-chevron {open ? 'sidebar__folder-chevron--open' : ''}"
											size="12"
											strokeWidth={2}
										/>
										{#if open}
											<FolderOpen class="sidebar__row__glyph" size="14" strokeWidth={1.5} />
										{:else}
											<Folder class="sidebar__row__glyph" size="14" strokeWidth={1.5} />
										{/if}
										<span class="sidebar__row__name">{f.name}</span>
										<span class="sidebar__row__time">{f.count}</span>
									</button>
									<button
										type="button"
										class="sidebar__row-menu-btn"
										aria-label="Folder actions"
										aria-haspopup="menu"
										aria-expanded={menuFor === `folder:${f.id}`}
										onclick={(e) => openMenu(`folder:${f.id}`, e)}
									>
										<MoreHorizontal size="14" strokeWidth={1.8} />
									</button>
								{/if}
								{#if menuFor === `folder:${f.id}`}
									<div
										class="sidebar__menu {menuDirection === 'up' ? 'sidebar__menu--up' : ''}"
										role="menu"
									>
										<button
											type="button"
											role="menuitem"
											onclick={() => {
												closeMenu();
												onSelectThread();
												void goto(`/projects/${f.id}`);
											}}
										>
											New chat in folder
										</button>
										<button type="button" role="menuitem" onclick={() => startRenameFolder(f)}>
											Rename
										</button>
										<button
											type="button"
											role="menuitem"
											class="sidebar__menu__danger"
											onclick={() => onFolderDeleteAction(f)}
										>
											{confirmDeleteFor === `folder:${f.id}` ? 'Click again (chats stay)' : 'Delete folder'}
										</button>
									</div>
								{/if}
							</div>
							{#if open}
								<div class="sidebar__folder-chats">
									{#each chats as c (c.id)}
										{@render chatRow(c)}
									{/each}
									{#if f.count === 0}
										<div class="sidebar__folder-empty">Empty. Drag a chat here or use its menu.</div>
									{:else if f.count > chats.length}
										<a class="sidebar__folder-more" href={`/projects/${f.id}`} onclick={onSelectThread}>
											View all {f.count}
										</a>
									{/if}
								</div>
							{/if}
						{/each}

						<div
							class="sidebar__chats-drop {dropTarget === 'unfiled' ? 'sidebar__chats-drop--active' : ''}"
							role="group"
							aria-label="Chats"
							ondragover={(e) => onDropTargetOver('unfiled', e)}
							ondragleave={(e) => onDropTargetLeave('unfiled', e)}
							ondrop={(e) => onDropOnTarget(null, e)}
						>
						<div class="sidebar__section">Chats</div>
					{#if unfiled.length === 0}
						<div class="sidebar__row" style="color:var(--ink-400);cursor:default">
							<span class="sidebar__row__name">{data.conversations.length === 0 ? 'No chats yet' : 'All chats are in folders'}</span>
						</div>
					{/if}

					{#each [['PINNED', groups.pinned], ['TODAY', groups.today], ['YESTERDAY', groups.yesterday], ['LAST 7 DAYS', groups.last7], ['EARLIER', groups.earlier]] as const as [label, items] (label)}
						{#if items.length > 0}
							<div class="sidebar__subsection">{label}</div>
							{#each items as c (c.id)}
								{@render chatRow(c)}
							{/each}
						{/if}
					{/each}
						</div>
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
			{#if navigating.to?.url.pathname.startsWith('/projects')}<p role="status" style="padding: 64px 24px 0">Loading folder…</p>{/if}
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

{#snippet chatRow(c: SidebarConvo)}
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
				draggable="true"
				ondragstart={(e) => onChatDragStart(c, e)}
				ondragend={onChatDragEnd}
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

		{#if menuFor === c.id && moveMenuFor === c.id}
			<div
				class="sidebar__menu {menuDirection === 'up' ? 'sidebar__menu--up' : ''}"
				role="menu"
				aria-label="Move to folder"
			>
				<button type="button" role="menuitem" class="sidebar__menu__back" onclick={() => (moveMenuFor = null)}>
					‹ Move to folder
				</button>
				{#each folders as f (f.id)}
					<button
						type="button"
						role="menuitem"
						disabled={c.folderId === f.id}
						onclick={() => moveChat(c.id, f.id)}
					>
						{f.name}{c.folderId === f.id ? ' ✓' : ''}
					</button>
				{/each}
				<button type="button" role="menuitem" onclick={() => startCreateFolder(c.id)}>New folder…</button>
				{#if c.folderId}
					<button type="button" role="menuitem" onclick={() => moveChat(c.id, null)}>
						Remove from folder
					</button>
				{/if}
			</div>
		{:else if menuFor === c.id}
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
				<button type="button" role="menuitem" onclick={() => (moveMenuFor = c.id)}>
				{c.folderId ? 'Move to another folder' : 'Move to folder'}
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
{/snippet}

{#snippet folderEditor(action: string)}
	<form class="sidebar__row sidebar__row--editing" onsubmit={commitFolderEdit}>
		<Folder class="sidebar__row__glyph" size="14" strokeWidth={1.5} />
		<input
			bind:this={folderInput}
			bind:value={folderDraft}
			class="sidebar__rename"
			aria-label="Folder name"
			placeholder="Folder name"
			maxlength="100"
			disabled={folderBusy}
			onkeydown={(e) => {
				if (e.key === 'Escape') {
					e.preventDefault();
					cancelFolderEdit();
				}
			}}
		/>
		<button type="submit" class="sidebar__rename-btn" disabled={folderBusy || !folderDraft.trim()}>
			{action}
		</button>
		<button type="button" class="sidebar__rename-btn" onclick={cancelFolderEdit}>Cancel</button>
	</form>
{/snippet}
