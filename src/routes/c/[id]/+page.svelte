<script lang="ts">
	import Composer from '$lib/components/Composer.svelte';
	import Thread from '$lib/components/Thread.svelte';
	import type { ChatMessage } from '$lib/types';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

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

	const topic = $derived.by(() => {
		const n = messages.length;
		if (n === 0) return '0 messages';
		const last = messages[n - 1];
		const ts = new Date(data.conversation.updatedAt);
		const h = ts.getHours().toString().padStart(2, '0');
		const m = ts.getMinutes().toString().padStart(2, '0');
		return `${n} message${n === 1 ? '' : 's'} · last update ${h}:${m} · ${last.role}`;
	});

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
			asstMsg.content += `\n\nCouldn't reach the agent. ${String(e)}`;
			asstMsg.partial = false;
			overlay = [userMsg, asstMsg];
		} finally {
			streaming = false;
		}
	}
</script>

<header class="pane__header">
	<div>
		<div class="pane__header__title">
			{data.conversation.title || 'Untitled thread'}
		</div>
		<div class="pane__header__topic">{topic}</div>
	</div>
</header>

<Thread {messages} />

<div class="composer-zone">
	<div class="composer-zone__inner">
		<Composer onSend={handleSend} disabled={streaming} />
	</div>
</div>
