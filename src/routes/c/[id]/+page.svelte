<script lang="ts">
	import Composer from '$lib/components/Composer.svelte';
	import Thread from '$lib/components/Thread.svelte';
	import ToolStrip from '$lib/components/ToolStrip.svelte';
	import type { ChatMessage } from '$lib/types';
	import { invalidateAll } from '$app/navigation';
	import { chat } from '$lib/stores/chat.svelte';
	import { onMount } from 'svelte';

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

	// Expose the last user message to the global ↑ shortcut.
	$effect(() => {
		const reversed = [...persisted].reverse();
		const lastUser = reversed.find((m) => m.role === 'user');
		chat.lastUserContent = lastUser ? lastUser.content : null;
		return () => {
			chat.lastUserContent = null;
		};
	});

	async function runStream(args: {
		conversation_id: string;
		content?: string;
		regenerate?: boolean;
	}) {
		streaming = true;
		const userMsg: ChatMessage | null = args.regenerate
			? null
			: { id: 'tmp-u-' + Date.now(), role: 'user', content: args.content ?? '', partial: false };
		const asstMsg: ChatMessage = {
			id: 'tmp-a-' + Date.now(),
			role: 'assistant',
			content: '',
			partial: true
		};
		overlay = userMsg ? [userMsg, asstMsg] : [asstMsg];

		const controller = chat.startStream();
		try {
			const { streamChat } = await import('$lib/client/stream');
			await streamChat(args, {
				signal: controller.signal,
				onDelta: (s) => {
					asstMsg.content += s;
					overlay = userMsg ? [userMsg, asstMsg] : [asstMsg];
				},
				onToolProgress: (t) => chat.pushTool({ ...t, startedAt: Date.now() }),
				onToolDone: (id) => chat.clearTool(id),
				onTitle: () => {
					/* title is updated server-side; invalidateAll below will pick it up */
				}
			});
			asstMsg.partial = false;
			overlay = userMsg ? [userMsg, asstMsg] : [asstMsg];
			await invalidateAll();
			overlay = [];
		} catch (e) {
			console.error(e);
			const aborted = (e as { name?: string })?.name === 'AbortError' || controller.signal.aborted;
			asstMsg.partial = false;
			if (!aborted) {
				asstMsg.content += `\n\nCouldn't reach the agent. ${String(e)}`;
				overlay = userMsg ? [userMsg, asstMsg] : [asstMsg];
			} else {
				// keep whatever streamed so far; the server has persisted partial
				await invalidateAll();
				overlay = [];
			}
		} finally {
			chat.endStream();
			streaming = false;
		}
	}

	async function handleSend(content: string) {
		await runStream({ conversation_id: data.conversation.id, content });
	}

	async function handleRegenerate() {
		await runStream({ conversation_id: data.conversation.id, regenerate: true });
	}

	// Pending prompt handoff: when the empty-state composer creates a new
	// conversation, it navigates here with #p=<encoded prompt>. We strip the
	// hash and fire the stream once.
	onMount(() => {
		if (typeof location === 'undefined') return;
		const m = location.hash.match(/^#p=(.+)$/);
		if (!m) return;
		let pending = '';
		try {
			pending = decodeURIComponent(m[1]);
		} catch {
			pending = '';
		}
		history.replaceState(null, '', location.pathname + location.search);
		if (pending) void handleSend(pending);
	});
</script>

<header class="pane__header">
	<div>
		<div class="pane__header__title">
			{data.conversation.title || 'Untitled thread'}
		</div>
		<div class="pane__header__topic">{topic}</div>
	</div>
</header>

<Thread {messages} onRegenerate={handleRegenerate} />

<div class="composer-zone">
	<div class="composer-zone__inner">
		<ToolStrip />
		<Composer onSend={handleSend} disabled={streaming} />
	</div>
</div>
