<script lang="ts">
	import Composer from '$lib/components/Composer.svelte';
	import Thread from '$lib/components/Thread.svelte';
	import type { ChatCommand, ChatMessage, MessageContent } from '$lib/types';
	import { contentText } from '$lib/types';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { chat } from '$lib/stores/chat.svelte';
	import { onMount } from 'svelte';
	import { formatThreadUpdated } from '$lib/utils/time';
	import { persistedThreadMessages, type PersistedThreadMessage } from '$lib/utils/thread-messages';

	type ThreadMessage = PersistedThreadMessage;

	let { data } = $props();

	// Per-stream overlay items keyed by their tmp ids. Each runStream pushes
	// its own user + assistant pair and removes them after invalidateAll picks
	// the persisted versions up. Using append-and-filter (not replace) so
	// concurrent or back-to-back runs don't trample each other.
	let overlay = $state<ThreadMessage[]>([]);
	// Persisted message ids that are currently being shadowed by an overlay
	// stream (resume). Hides the partial row while we re-stream into it; on
	// invalidateAll the partial flag flips and the row reappears finalized.
	let hiddenIds = $state<Set<string>>(new Set());

	const persisted = $derived(persistedThreadMessages(data.messages, hiddenIds));
	const messages = $derived([...persisted, ...overlay]);

	const topic = $derived.by(() => {
		const n = messages.length;
		if (n === 0) return '0 messages';
		const last = messages[n - 1];
		return `${n} message${n === 1 ? '' : 's'} · updated ${formatThreadUpdated(
			data.conversation.updatedAt
		)} · ${last.role}`;
	});

	$effect(() => {
		const reversed = [...persisted].reverse();
		const lastUser = reversed.find((m) => m.role === 'user');
		chat.lastUserContent = lastUser ? contentText(lastUser.content) : null;
		return () => {
			chat.lastUserContent = null;
		};
	});

	// Serialise runStream calls so abort + restart from a mid-stream send can't
	// race the previous run's finally block.
	let activeStream: Promise<void> = Promise.resolve();

	async function runStream(args: {
		conversation_id: string;
		content?: MessageContent;
		regenerate?: boolean;
		resume?: boolean;
		message_id?: string;
		command?: ChatCommand;
	}) {
		// startStream aborts any prior controller; wait for the previous run to
		// fully unwind so its overlay cleanup completes before we add our own.
		const prior = activeStream;
		const controller = chat.startStream();
		await prior.catch(() => {});

		const isResume = args.resume === true && !!args.message_id;
		const resumingId = isResume ? (args.message_id as string) : null;

		const userMsg: ThreadMessage | null = args.regenerate || isResume
			? null
			: {
					id: 'tmp-u-' + Math.random().toString(36).slice(2),
					role: 'user',
					content: args.content ?? '',
					partial: false,
					createdAt: Date.now()
				};

		// Resume: seed the overlay with the partial's existing content so
		// streaming visually continues from where it left off, and hide the
		// persisted row so we don't double-render it.
		const seedContent = isResume
			? (() => {
					const src = data.messages.find((m) => m.id === resumingId);
					if (!src) return '';
					return contentText(src.content);
				})()
			: '';
		const asstMsg: ThreadMessage = {
			id: 'tmp-a-' + Math.random().toString(36).slice(2),
			role: 'assistant',
			content: seedContent,
			partial: true,
			streaming: true,
			createdAt: Date.now()
		};
		let asstText = seedContent;
		overlay = [...overlay, ...(userMsg ? [userMsg] : []), asstMsg];
		if (resumingId) {
			hiddenIds = new Set([...hiddenIds, resumingId]);
		}

		const run = (async () => {
			try {
				const { streamChat } = await import('$lib/client/stream');
				await streamChat(args, {
					signal: controller.signal,
					onDelta: (s) => {
						asstText += s;
						asstMsg.content = asstText;
						overlay = [...overlay];
					},
					onToolProgress: (t) => chat.pushTool(t),
					onToolDone: (id, tool) => chat.clearTool(id, tool),
					onSource: (source) =>
						chat.pushSource({
							...source,
							domain: source.domain || source.url,
							updatedAt: Date.now()
						})
				});
				asstMsg.partial = false;
				asstMsg.streaming = false;
				overlay = [...overlay];
			} catch (e) {
				const aborted = (e as { name?: string })?.name === 'AbortError' || controller.signal.aborted;
				const wantsPartialAnswer = aborted && chat.abortIntent === 'partial';
				asstMsg.partial = false;
				asstMsg.streaming = false;
				if (wantsPartialAnswer && asstText.trim() === seedContent.trim()) {
					const note =
						'I stopped the source run before the agent produced a usable draft. No partial answer was available yet.';
					asstText = seedContent ? `${seedContent}\n\n${note}` : note;
					asstMsg.content = asstText;
					try {
						await fetch(`/api/conversations/${data.conversation.id}/assistant-note`, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ content: note })
						});
					} catch {
						/* the local overlay still tells the user what happened */
					}
				} else if (!aborted) {
					asstText += `\n\nCouldn't reach the agent. ${String(e)}`;
					asstMsg.content = asstText;
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
				if (resumingId) {
					const next = new Set(hiddenIds);
					next.delete(resumingId);
					hiddenIds = next;
				}
				if (chat.abort === controller) chat.endStream();
			}
		})();
		activeStream = run;
		return run;
	}

	async function handleSend(content: MessageContent, command?: ChatCommand) {
		await runStream({ conversation_id: data.conversation.id, content, command });
	}

	async function handleRegenerate() {
		await runStream({ conversation_id: data.conversation.id, regenerate: true });
	}

	async function handleResume(messageId: string) {
		await runStream({
			conversation_id: data.conversation.id,
			resume: true,
			message_id: messageId
		});
	}

	async function handleDiscard(messageId: string) {
		try {
			await fetch(`/api/messages/${messageId}/clear-partial`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversation_id: data.conversation.id })
			});
		} catch {
			/* ignore — invalidateAll surfaces any persisted state */
		}
		try {
			await invalidateAll();
		} catch {
			/* ignore */
		}
	}

	onMount(() => {
		if (typeof location === 'undefined') return;
		const m = location.hash.match(/^#p=(.*)$/);
		if (!m) return;
		const stashKey = 'hermes:pending:' + data.conversation.id;
		let stashed: MessageContent | null = null;
		try {
			const raw = sessionStorage.getItem(stashKey);
			if (raw) {
				sessionStorage.removeItem(stashKey);
				stashed = JSON.parse(raw) as MessageContent;
			}
		} catch {
			stashed = null;
		}
		let pending = '';
		try {
			pending = decodeURIComponent(m[1]);
		} catch {
			pending = '';
		}
		replaceState(location.pathname + location.search, {});
		if (stashed) void handleSend(stashed);
		else if (pending) void handleSend(pending);
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

{#key data.conversation.id}
	<Thread {messages} onRegenerate={handleRegenerate} onResume={handleResume} onDiscard={handleDiscard} />
{/key}

<div class="composer-zone">
	<div class="composer-zone__inner">
		<Composer onSend={handleSend} />
	</div>
</div>
