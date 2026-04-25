<script lang="ts">
	import { goto } from '$app/navigation';

	interface Props {
		onSend?: (content: string) => Promise<void> | void;
		disabled?: boolean;
	}
	let { onSend, disabled = false }: Props = $props();

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
				// no handler → start a new conversation by streaming once and navigating
				const r = await fetch('/api/chat/stream', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ content })
				});
				if (!r.ok) throw new Error(`stream ${r.status}`);
				if (!r.body) throw new Error('no stream body');
				// Read just the meta frame to get the conversation id, then redirect.
				// The stream still runs server-side and will persist the assistant message.
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
	style="display:flex;gap:0.5rem;align-items:flex-end"
>
	<textarea
		bind:this={textarea}
		bind:value
		oninput={autosize}
		onkeydown={onKey}
		placeholder="Message Hermes…  (Enter to send, Shift+Enter for newline)"
		rows="1"
		disabled={disabled || busy}
		style="flex:1;resize:none;padding:0.6rem 0.75rem;border:1px solid #ccc;border-radius:8px;font:inherit;line-height:1.4;outline:none"
	></textarea>
	<button
		type="submit"
		disabled={disabled || busy || !value.trim()}
		style="padding:0.6rem 1rem;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer;font:inherit"
	>
		{busy ? '…' : 'Send'}
	</button>
</form>
