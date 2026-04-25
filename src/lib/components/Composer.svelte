<script lang="ts">
	import { goto } from '$app/navigation';
	import Send from 'lucide-svelte/icons/send-horizontal';
	import Paperclip from 'lucide-svelte/icons/paperclip';

	interface Props {
		onSend?: (content: string) => Promise<void> | void;
		disabled?: boolean;
		placeholder?: string;
	}
	let { onSend, disabled = false, placeholder = 'Message NewsCraft' }: Props = $props();

	let value = $state('');
	let textarea: HTMLTextAreaElement | undefined;
	let busy = $state(false);

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
				// no handler → start a new conversation: stream once, capture the
				// conversation_id from the meta frame, navigate.
				const r = await fetch('/api/chat/stream', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ content })
				});
				if (!r.ok) throw new Error(`stream ${r.status}`);
				if (!r.body) throw new Error('no stream body');
				const dec = new TextDecoder();
				const reader = r.body.getReader();
				let buf = '';
				let convoId: string | null = null;
				while (!convoId) {
					const { value: chunk, done } = await reader.read();
					if (done) break;
					buf += dec.decode(chunk, { stream: true });
					const m = buf.match(/event:\s*hermes\.meta\s*\ndata:\s*(\{[^\n]+\})/);
					if (m) {
						try {
							convoId = (JSON.parse(m[1]) as { conversation_id: string }).conversation_id;
						} catch {
							/* ignore */
						}
					}
				}
				reader.cancel().catch(() => {});
				if (convoId) {
					value = '';
					await goto(`/c/${convoId}`);
				}
			}
		} finally {
			busy = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
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
	</div>
</form>
