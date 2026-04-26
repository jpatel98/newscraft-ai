<script lang="ts">
	import Composer from '$lib/components/Composer.svelte';
	import Thread from '$lib/components/Thread.svelte';
	import ToolStrip from '$lib/components/ToolStrip.svelte';
	import type { ChatMessage } from '$lib/types';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { chat } from '$lib/stores/chat.svelte';
	import { onMount } from 'svelte';

	let { data } = $props();

	// Per-stream overlay items keyed by their tmp ids. Each runStream pushes
	// its own user + assistant pair and removes them after invalidateAll picks
	// the persisted versions up. Using append-and-filter (not replace) so
	// concurrent or back-to-back runs don't trample each other.
	let overlay = $state<ChatMessage[]>([]);

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

	$effect(() => {
		const reversed = [...persisted].reverse();
		const lastUser = reversed.find((m) => m.role === 'user');
		chat.lastUserContent = lastUser ? lastUser.content : null;
		return () => {
			chat.lastUserContent = null;
		};
	});

	// Serialise runStream calls so abort + restart from a mid-stream send can't
	// race the previous run's finally block.
	let activeStream: Promise<void> = Promise.resolve();

	async function runStream(args: {
		conversation_id: string;
		content?: string;
		regenerate?: boolean;
	}) {
		// startStream aborts any prior controller; wait for the previous run to
		// fully unwind so its overlay cleanup completes before we add our own.
		const prior = activeStream;
		const controller = chat.startStream();
		await prior.catch(() => {});

		const userMsg: ChatMessage | null = args.regenerate
			? null
			: {
					id: 'tmp-u-' + Math.random().toString(36).slice(2),
					role: 'user',
					content: args.content ?? '',
					partial: false
				};
		const asstMsg: ChatMessage = {
			id: 'tmp-a-' + Math.random().toString(36).slice(2),
			role: 'assistant',
			content: '',
			partial: true,
			streaming: true
		};
		overlay = [...overlay, ...(userMsg ? [userMsg] : []), asstMsg];

		const run = (async () => {
			try {
				const { streamChat } = await import('$lib/client/stream');
				await streamChat(args, {
					signal: controller.signal,
					onDelta: (s) => {
						asstMsg.content += s;
						overlay = [...overlay];
					},
					onToolProgress: (t) => chat.pushTool({ ...t, startedAt: Date.now() }),
					onToolDone: (id) => chat.clearTool(id)
				});
				asstMsg.partial = false;
				asstMsg.streaming = false;
				overlay = [...overlay];
			} catch (e) {
				const aborted = (e as { name?: string })?.name === 'AbortError' || controller.signal.aborted;
				asstMsg.partial = false;
				asstMsg.streaming = false;
				if (!aborted) {
					asstMsg.content += `\n\nCouldn't reach the agent. ${String(e)}`;
				}
				overlay = [...overlay];
			} finally {
				try {
					await invalidateAll();
				} catch {
					/* ignore */
				}
				// Drop only this run's items from the overlay (other runs may have
				// added their own).
				const ids = new Set([asstMsg.id, ...(userMsg ? [userMsg.id] : [])]);
				overlay = overlay.filter((m) => !ids.has(m.id));
				if (chat.abort === controller) chat.endStream();
			}
		})();
		activeStream = run;
		return run;
	}

	async function handleSend(content: string) {
		await runStream({ conversation_id: data.conversation.id, content });
	}

	async function handleRegenerate() {
		await runStream({ conversation_id: data.conversation.id, regenerate: true });
	}

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
		replaceState(location.pathname + location.search, {});
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
		<Composer onSend={handleSend} />
	</div>
</div>
