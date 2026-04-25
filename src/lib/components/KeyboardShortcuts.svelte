<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { chat } from '$lib/stores/chat.svelte';

	interface Props {
		conversations: Array<{ id: string }>;
	}
	let { conversations }: Props = $props();

	let helpOpen = $state(false);

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

		// ↑ on empty composer-textfield — edit-last
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
</script>

{#if helpOpen}
	<div
		class="kbd-help"
		role="dialog"
		aria-label="Keyboard shortcuts"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) helpOpen = false;
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') helpOpen = false;
		}}
	>
		<div class="kbd-help__panel">
			<div class="kbd-help__sub">Keyboard · NewsCraft</div>
			<div class="kbd-help__title">Shortcuts</div>
			<dl>
				<dt>Send message</dt>
				<dd><kbd>Enter</kbd></dd>

				<dt>New line</dt>
				<dd><kbd>Shift</kbd> <kbd>Enter</kbd></dd>

				<dt>New thread</dt>
				<dd><kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>O</kbd></dd>

				<dt>Edit last message</dt>
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
