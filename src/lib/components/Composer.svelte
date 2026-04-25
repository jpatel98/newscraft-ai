<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import Send from 'lucide-svelte/icons/send-horizontal';
	import Paperclip from 'lucide-svelte/icons/paperclip';
	import { chat } from '$lib/stores/chat.svelte';

	interface Props {
		onSend?: (content: string) => Promise<void> | void;
		disabled?: boolean;
		placeholder?: string;
	}
	let { onSend, disabled = false, placeholder = 'Message NewsCraft' }: Props = $props();

	let value = $state('');
	let textarea: HTMLTextAreaElement | undefined = $state();
	let busy = $state(false); // only used to gate the new-thread fetch (synchronous create-conv)

	function autosize() {
		if (!textarea) return;
		// Reset first so shrinking works; cap via CSS max-height (no JS clamp).
		textarea.style.height = 'auto';
		textarea.style.height = textarea.scrollHeight + 'px';
	}

	// Re-measure after every value change once Svelte has flushed the DOM.
	$effect(() => {
		value;
		queueMicrotask(autosize);
	});

	onMount(() => {
		autosize();
	});

	// Consume any edit-last handoff from the ↑ shortcut.
	$effect(() => {
		const recall = chat.editRequest;
		if (recall != null && !value) {
			value = recall;
			chat.consumeEdit();
			queueMicrotask(() => {
				textarea?.focus();
				autosize();
			});
		}
	});

	export function focus() {
		textarea?.focus();
	}

	async function send() {
		const content = value.trim();
		if (!content || disabled) return;
		if (onSend) {
			// Hand the content off and clear the input immediately. The parent
			// owns serialisation (abort current stream, await previous, start new),
			// so we don't gate on a local busy flag — the user can keep typing.
			value = '';
			void onSend(content);
			queueMicrotask(() => textarea?.focus());
			return;
		}
		// New-thread flow: synchronous create-conv then navigate.
		if (busy) return;
		busy = true;
		try {
			const r = await fetch('/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			});
			if (!r.ok) throw new Error(`create-conv ${r.status}`);
			const { id } = (await r.json()) as { id: string };
			value = '';
			await goto(`/c/${id}#p=${encodeURIComponent(content)}`);
		} finally {
			busy = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
			return;
		}
		if (e.key === 'Escape' && document.activeElement === textarea) {
			textarea?.blur();
			e.preventDefault();
		}
	}

	// Send is allowed while a stream is in flight — the parent will abort the
	// current reply, persist the partial, and start a new one.
	const canSend = $derived(value.trim().length > 0 && !busy && !disabled);
	const showInterruptHint = $derived(disabled && value.trim().length > 0);
</script>

<form
	onsubmit={(e) => {
		e.preventDefault();
		send();
	}}
>
	<div class="composer" class:composer--busy={busy}>
		<button
			type="button"
			class="composer__icon-btn"
			disabled
			aria-label="Attach file (coming soon)"
			title="Attachments coming soon"
		>
			<Paperclip size="16" strokeWidth={1.5} />
		</button>
		<textarea
			bind:this={textarea}
			bind:value
			onkeydown={onKey}
			class="composer__textarea"
			{placeholder}
			rows="1"
			disabled={busy}
			aria-label="Message NewsCraft"
		></textarea>
		<button
			type="submit"
			class="composer__send"
			disabled={!canSend}
			aria-label="Send message"
		>
			<Send size="14" strokeWidth={2} />
			<span>Send</span>
		</button>
	</div>
	<div class="composer__hint">
		{#if showInterruptHint}
			<span style="color:var(--accent-fg)"
				><kbd>Enter</kbd> interrupts the current reply and sends</span
			>
		{:else}
			<span
				><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline · <kbd>Esc</kbd>
				to abort · <kbd>↑</kbd> to edit last</span
			>
		{/if}
	</div>
</form>
