<script lang="ts">
	import Composer from '$lib/components/Composer.svelte';
	import Thread from '$lib/components/Thread.svelte';
	import type { ChatMessage } from '$lib/types';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	// In-flight messages for the current send. After the server persists them
	// and we invalidate(), they appear in `data.messages` and we drop them.
	let overlay = $state<ChatMessage[]>([]);
	let streaming = $state(false);

	const persisted = $derived(
		data.messages.map<ChatMessage>((m) => ({
			id: m.id,
			role: m.role,
			content: m.content,
			partial: m.partial
		}))
	);
	const messages = $derived([...persisted, ...overlay]);

	async function handleSend(content: string) {
		streaming = true;
		const userMsg: ChatMessage = {
			id: 'tmp-u-' + Date.now(),
			role: 'user',
			content,
			partial: false
		};
		const asstMsg: ChatMessage = {
			id: 'tmp-a-' + Date.now(),
			role: 'assistant',
			content: '',
			partial: true
		};
		overlay = [userMsg, asstMsg];

		try {
			const { streamChat } = await import('$lib/client/stream');
			await streamChat(
				{ conversation_id: data.conversation.id, content },
				{
					onDelta: (s) => {
						asstMsg.content += s;
						overlay = [userMsg, asstMsg];
					}
				}
			);
			asstMsg.partial = false;
			overlay = [userMsg, asstMsg];
			await invalidateAll();
			overlay = [];
		} catch (e) {
			console.error(e);
			asstMsg.content += `\n\n[stream error: ${String(e)}]`;
			overlay = [userMsg, asstMsg];
		} finally {
			streaming = false;
		}
	}
</script>

<div style="display:flex;flex-direction:column;height:100%">
	<Thread {messages} />
	<div style="border-top:1px solid #eee;padding:1rem;background:#fafafa">
		<div style="max-width:760px;margin:0 auto">
			<Composer onSend={handleSend} disabled={streaming} />
		</div>
	</div>
</div>
