<script lang="ts">
	import { goto } from '$app/navigation';
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
	let busy = $state(false);

	// Consume any edit-last handoff from the ↑ shortcut.
	$effect(() => {
		const recall = chat.editRequest;
		if (recall != null && !value) {
			value = recall;
			chat.consumeEdit();
			queueMicrotask(() => {
				if (textarea) {
					textarea.focus();
					autosize();
				}
			});
		}
	});

	export function focus() {
		textarea?.focus();
	}

	async function send() {
		const content = value.trim();
		if (!content || busy || disabled) return;
		busy = true;
		try {
			if (onSend) {
				value = '';
				autosize();
				await onSend(content);
			} else {
				// New-thread flow: create the conversation synchronously, then
				// navigate to /c/<id> with the prompt in the URL hash. The hash
				// stays client-side and is consumed by the page on mount, which
				// fires the actual stream from there. Avoids the prior bug where
				// the in-flight fetch was cancelled during navigation.
				const r = await fetch('/api/conversations', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}'
				});
				if (!r.ok) throw new Error(`create-conv ${r.status}`);
				const { id } = (await r.json()) as { id: string };
				value = '';
				autosize();
				await goto(`/c/${id}#p=${encodeURIComponent(content)}`);
			}
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
		// Esc inside the composer first blurs; the global handler will then
		// catch a second Esc to abort the stream. Keeps both gestures usable.
		if (e.key === 'Escape' && document.activeElement === textarea) {
			textarea?.blur();
			e.preventDefault();
		}
	}

	function autosize() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = Math.min(textarea.scrollHeight, window.innerHeight * 0.4) + 'px';
	}
</script>

<form
	onsubmit={(e) => {
		e.preventDefault();
		send();
	}}
>
	<div class="composer">
		<button
			type="button"
			class="btn btn--ghost"
			disabled
			aria-label="Attach (coming soon)"
			title="Attachments coming soon"
			style="padding:6px;border:0;background:transparent;color:var(--fg-3)"
		>
			<Paperclip size="16" strokeWidth={1.5} />
		</button>
		<textarea
			bind:this={textarea}
			bind:value
			oninput={autosize}
			onkeydown={onKey}
			class="composer__textarea"
			{placeholder}
			rows="1"
			disabled={disabled || busy}
			aria-label="Message NewsCraft"
		></textarea>
		<button
			type="submit"
			class="btn btn--primary"
			disabled={disabled || busy || !value.trim()}
			aria-label="Send"
		>
			<Send size="14" strokeWidth={2} />
			<span>{busy ? 'Sending' : 'Send'}</span>
		</button>
	</div>
	<div class="composer__hint">
		<span><kbd>Enter</kbd> to send</span>
		<span><kbd>Shift</kbd> + <kbd>Enter</kbd> for newline</span>
		<span><kbd>Esc</kbd> to abort</span>
		<span><kbd>↑</kbd> to edit last</span>
	</div>
</form>
