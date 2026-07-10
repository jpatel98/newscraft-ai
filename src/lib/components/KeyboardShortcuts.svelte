<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { chat } from '$lib/stores/chat.svelte';
	import { activeHTMLElement, focusDialog, restoreFocus, trapTabKey } from '$lib/utils/focus';

	interface Props {
		conversations: Array<{ id: string }>;
	}
	let { conversations }: Props = $props();

	let helpOpen = $state(false);
	let helpDialog = $state<HTMLDivElement | null>(null);
	let helpOpener = $state<HTMLElement | null>(null);
	let wasHelpOpen = false;

	function isMod(e: KeyboardEvent): boolean {
		return e.metaKey || e.ctrlKey;
	}

	function isInTextField(): boolean {
		const el = document.activeElement;
		if (!el) return false;
		const tag = el.tagName;
		return (
			tag === 'INPUT' ||
			tag === 'TEXTAREA' ||
			tag === 'SELECT' ||
			(el as HTMLElement).isContentEditable === true
		);
	}

	function handle(e: KeyboardEvent) {
		// Esc — abort stream (always), then close help if open
		if (e.key === 'Escape') {
			if (helpOpen) {
				helpOpen = false;
				e.preventDefault();
				return;
			}
			if (chat.streaming) {
				chat.cancel();
				e.preventDefault();
				return;
			}
		}

		// Cmd+Shift+O — new chat
		if (isMod(e) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
			e.preventDefault();
			goto('/');
			return;
		}

		// Cmd+/ — keyboard help overlay
		if (isMod(e) && e.key === '/') {
			e.preventDefault();
			helpOpen = !helpOpen;
			return;
		}

		// ↑ on empty composer-textfield — reuse the last prompt
		if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !isMod(e)) {
			const el = document.activeElement as HTMLTextAreaElement | null;
			if (el && el.tagName === 'TEXTAREA' && (el.value ?? '').length === 0) {
				const prev = chat.lastUserContent;
				if (prev) {
					e.preventDefault();
					chat.requestEdit(prev);
				}
			}
			return;
		}

		// Cmd+[ / Cmd+] — prev / next thread (don't fire while typing)
		if (isMod(e) && (e.key === '[' || e.key === ']') && !isInTextField()) {
			if (conversations.length === 0) return;
			const currentId = page.params.id ?? '';
			const i = conversations.findIndex((c) => c.id === currentId);
			let target = -1;
			if (e.key === '[') target = i <= 0 ? conversations.length - 1 : i - 1;
			else target = i < 0 || i >= conversations.length - 1 ? 0 : i + 1;
			if (target >= 0) {
				e.preventDefault();
				goto(`/c/${conversations[target].id}`);
			}
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handle);
		return () => window.removeEventListener('keydown', handle);
	});

	$effect(() => {
		if (helpOpen && !wasHelpOpen) {
			helpOpener = activeHTMLElement();
			void tick().then(() => {
				if (helpOpen) focusDialog(helpDialog);
			});
		} else if (!helpOpen && wasHelpOpen) {
			const restoreTarget = helpOpener;
			helpOpener = null;
			void tick().then(() => restoreFocus(restoreTarget));
		}
		wasHelpOpen = helpOpen;
	});
</script>

{#if helpOpen}
	<div
		bind:this={helpDialog}
		class="kbd-help"
		role="dialog"
		aria-modal="true"
		aria-labelledby="kbd-help-title"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) helpOpen = false;
		}}
		onkeydown={(e) => {
			if (trapTabKey(e, helpDialog)) return;
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				helpOpen = false;
			}
		}}
	>
		<div class="kbd-help__panel" role="document">
			<div class="kbd-help__sub">Keyboard · NewsCraft</div>
			<div id="kbd-help-title" class="kbd-help__title">Shortcuts</div>
			<dl>
				<dt>Send message</dt>
				<dd><kbd>Enter</kbd></dd>

				<dt>New line</dt>
				<dd><kbd>Shift</kbd> <kbd>Enter</kbd></dd>

				<dt>New thread</dt>
				<dd><kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>O</kbd></dd>

				<dt>Reuse last prompt</dt>
				<dd><kbd>↑</kbd></dd>

				<dt>Previous / next thread</dt>
				<dd><kbd>⌘</kbd> <kbd>[</kbd> / <kbd>]</kbd></dd>

				<dt>Abort current reply</dt>
				<dd><kbd>Esc</kbd></dd>

				<dt>This help</dt>
				<dd><kbd>⌘</kbd> <kbd>/</kbd></dd>
			</dl>
		</div>
	</div>
{/if}
