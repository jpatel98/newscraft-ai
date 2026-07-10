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
	import { parseSlashCommand } from '$lib/utils/slash';
	import { streamFailureMessage } from '$lib/client/stream';
	import X from 'lucide-svelte/icons/x';
	import Send from 'lucide-svelte/icons/send-horizontal';

	type ThreadMessage = PersistedThreadMessage;
	type FailedSend = { content: MessageContent; command?: ChatCommand };

	let { data } = $props();

	// Per-stream overlay items keyed by their tmp ids. Each runStream pushes
	// its own user + assistant pair and removes them after invalidateAll picks
	// the persisted versions up. Using append-and-filter (not replace) so
	// concurrent or back-to-back runs don't trample each other.
	let overlay = $state<ThreadMessage[]>([]);
	let feedbackOpen = $state(false);
	let feedbackComment = $state('');
	let feedbackSaving = $state(false);
	let feedbackStatus = $state<string | null>(null);
	let feedbackError = $state<string | null>(null);
	let failedRetry = $state<FailedSend | null>(null);
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

	function clearFailureOverlays() {
		overlay = overlay.filter((m) => !m.failure);
	}

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
		const controller = chat.startStream(args.conversation_id);
		await prior.catch(() => {});

		const isResume = args.resume === true && !!args.message_id;
		const isRetryableSend = Boolean(args.content && !args.regenerate && !isResume);
		if (isRetryableSend) clearFailureOverlays();
		const resumingId = isResume ? (args.message_id as string) : null;

		const userMsg: ThreadMessage | null =
			args.regenerate || isResume
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
		let streamEstablished = false;
		let keepFailureAssistant = false;
		let failureToRethrow: unknown = null;
		const noteStreamEstablished = () => {
			streamEstablished = true;
		};

		overlay = [...overlay, ...(userMsg ? [userMsg] : []), asstMsg];
		if (resumingId) {
			hiddenIds = new Set([...hiddenIds, resumingId]);
		}

		const run = (async () => {
			try {
				const { streamChat } = await import('$lib/client/stream');
				await streamChat(args, {
					signal: controller.signal,
					onMeta: noteStreamEstablished,
					onDelta: (s) => {
						noteStreamEstablished();
						chat.noteAssistantOutput(s);
						asstText += s;
						asstMsg.content = asstText;
						overlay = [...overlay];
					},
					onToolProgress: (t) => {
						noteStreamEstablished();
						chat.pushTool(t);
					},
					onToolDone: (id, tool) => {
						noteStreamEstablished();
						chat.clearTool(id, tool);
					},
					onSource: (source) => {
						noteStreamEstablished();
						chat.pushSource({
							...source,
							domain: source.domain || source.url,
							updatedAt: Date.now()
						});
					},
					onPlan: (plan) => {
						noteStreamEstablished();
						chat.setPlan(plan);
					}
				});
				if (isRetryableSend) failedRetry = null;
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
						'I stopped the source run before the agent produced a usable answer. No partial answer was available yet.';
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
					const message = streamFailureMessage(e);
					asstText = asstText.trim() ? `${asstText}\n\n${message}` : message;
					asstMsg.content = asstText;
					if (isRetryableSend && args.content) {
						asstMsg.failure = { retryable: true };
						failedRetry = { content: args.content, command: args.command };
					}
					keepFailureAssistant = true;
					if (isRetryableSend && !streamEstablished) failureToRethrow = e;
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
				const ids = new Set([...(userMsg ? [userMsg.id] : [])]);
				if (!keepFailureAssistant) ids.add(asstMsg.id);
				overlay = overlay.filter((m) => !ids.has(m.id));
				if (resumingId) {
					const next = new Set(hiddenIds);
					next.delete(resumingId);
					hiddenIds = next;
				}
				if (chat.abort === controller) chat.endStream();
				if (failureToRethrow) throw failureToRethrow;
			}
		})();
		activeStream = run;
		return run;
	}

	async function handleSend(content: MessageContent, command?: ChatCommand) {
		const parsedCommand = typeof content === 'string' ? parseSlashCommand(content) : null;
		if (command?.slash === '/feedback' || parsedCommand?.slash === '/feedback') {
			feedbackComment = (command?.raw ?? parsedCommand?.raw ?? '').replace(/^\/feedback\b/i, '').trim();
			feedbackStatus = null;
			feedbackError = null;
			feedbackOpen = true;
			return;
		}
		await runStream({ conversation_id: data.conversation.id, content, command });
	}

	async function submitFeedback() {
		const comment = feedbackComment.trim();
		if (!comment) {
			feedbackError = 'Add a comment before saving feedback.';
			return;
		}
		feedbackSaving = true;
		feedbackError = null;
		feedbackStatus = null;
		try {
			const response = await fetch(`/api/conversations/${data.conversation.id}/feedback`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ comment })
			});
			if (!response.ok) throw new Error(`feedback ${response.status}`);
			const result = (await response.json()) as { messageCount: number };
			feedbackStatus = `Captured ${result.messageCount} message${result.messageCount === 1 ? '' : 's'}.`;
			setTimeout(() => {
				if (feedbackStatus) feedbackOpen = false;
			}, 900);
		} catch {
			feedbackError = "Couldn't save feedback. Try again.";
		} finally {
			feedbackSaving = false;
		}
	}

	function closeFeedback() {
		if (feedbackSaving) return;
		feedbackOpen = false;
		feedbackStatus = null;
		feedbackError = null;
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

	async function handleRetryFailure() {
		const retry = failedRetry;
		if (!retry) return;
		clearFailureOverlays();
		failedRetry = null;
		try {
			await runStream({
				conversation_id: data.conversation.id,
				content: retry.content,
				command: retry.command
			});
		} catch {
			/* runStream already leaves the safe retry state visible */
		}
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
		const stashKey = 'agent:pending:' + data.conversation.id;
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
		<Thread
			{messages}
			conversationId={data.conversation.id}
			onRegenerate={handleRegenerate}
			onResume={handleResume}
			onDiscard={handleDiscard}
			onRetryFailure={handleRetryFailure}
		/>
{/key}

{#if feedbackOpen}
	<div class="feedback-backdrop">
		<button
			type="button"
			class="feedback-backdrop__dismiss"
			aria-label="Dismiss feedback"
			onclick={closeFeedback}
			disabled={feedbackSaving}
		></button>
		<div
			class="feedback-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="feedback-title"
		>
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void submitFeedback();
			}}
		>
			<div class="feedback-dialog__head">
				<div>
					<div id="feedback-title" class="feedback-dialog__title">Capture feedback</div>
					<div class="feedback-dialog__meta">
						{messages.length} message{messages.length === 1 ? '' : 's'} in this thread
					</div>
				</div>
				<button
					type="button"
					class="feedback-dialog__icon"
					aria-label="Close feedback"
					onclick={closeFeedback}
					disabled={feedbackSaving}
				>
					<X size="16" strokeWidth={1.8} />
				</button>
			</div>
			<textarea
				class="feedback-dialog__textarea"
				bind:value={feedbackComment}
				rows="5"
				maxlength="4000"
				placeholder="What should we know about this chat?"
				aria-label="Feedback comment"
				disabled={feedbackSaving}
			></textarea>
			{#if feedbackError}
				<div class="feedback-dialog__error" role="alert">{feedbackError}</div>
			{:else if feedbackStatus}
				<div class="feedback-dialog__status" role="status">{feedbackStatus}</div>
			{/if}
			<div class="feedback-dialog__actions">
				<button
					type="button"
					class="feedback-dialog__btn"
					onclick={closeFeedback}
					disabled={feedbackSaving}
				>
					Cancel
				</button>
				<button
					type="submit"
					class="feedback-dialog__btn feedback-dialog__btn--primary"
					disabled={feedbackSaving || !feedbackComment.trim()}
				>
					<Send size="14" strokeWidth={2} />
					<span>{feedbackSaving ? 'Saving' : 'Save feedback'}</span>
				</button>
			</div>
		</form>
		</div>
	</div>
{/if}

<div class="composer-zone">
	<div class="composer-zone__inner">
		<Composer onSend={handleSend} draftKey={data.conversation.id} />
	</div>
</div>

<style>
	.feedback-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: grid;
		place-items: center;
		padding: 20px;
		background: color-mix(in srgb, var(--ink-900) 28%, transparent);
	}
	.feedback-backdrop__dismiss {
		position: absolute;
		inset: 0;
		border: 0;
		background: transparent;
		padding: 0;
		cursor: default;
	}
	.feedback-dialog {
		position: relative;
		width: min(560px, 100%);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		box-shadow: var(--shadow-2);
		padding: 16px;
		display: grid;
		gap: 12px;
	}
	.feedback-dialog__head {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 12px;
	}
	.feedback-dialog__title {
		font-family: var(--font-display);
		font-size: 17px;
		font-weight: 650;
		letter-spacing: 0;
		color: var(--fg-1);
	}
	.feedback-dialog__meta {
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.feedback-dialog__icon {
		width: 32px;
		height: 32px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		background: var(--bg-surface);
		color: var(--fg-2);
		display: inline-grid;
		place-items: center;
		cursor: pointer;
	}
	.feedback-dialog__icon:hover:not(:disabled) {
		background: var(--bg-raised);
		color: var(--fg-1);
	}
	.feedback-dialog__icon:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.feedback-dialog__textarea {
		width: 100%;
		min-height: 120px;
		resize: vertical;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-2);
		background: var(--bg-page);
		color: var(--fg-1);
		font: inherit;
		font-size: 14px;
		line-height: 1.5;
		padding: 10px 12px;
		outline: none;
	}
	.feedback-dialog__textarea:focus {
		border-color: var(--border-strong);
		box-shadow: var(--shadow-focus);
	}
	.feedback-dialog__textarea::placeholder {
		color: var(--fg-4);
	}
	.feedback-dialog__error,
	.feedback-dialog__status {
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0;
	}
	.feedback-dialog__error {
		color: var(--danger-fg, #b34040);
	}
	.feedback-dialog__status {
		color: var(--cobalt-700);
	}
	.feedback-dialog__actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.feedback-dialog__btn {
		min-height: 34px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		background: var(--bg-surface);
		color: var(--fg-2);
		padding: 0 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
	}
	.feedback-dialog__btn:hover:not(:disabled) {
		background: var(--bg-raised);
		color: var(--fg-1);
	}
	.feedback-dialog__btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.feedback-dialog__btn--primary {
		background: var(--ink-900);
		border-color: var(--ink-900);
		color: var(--ink-25);
	}
	.feedback-dialog__btn--primary:hover:not(:disabled) {
		background: var(--ink-700);
		border-color: var(--ink-700);
		color: var(--ink-25);
	}
	@media (max-width: 560px) {
		.feedback-backdrop {
			padding: 12px;
			align-items: end;
		}
		.feedback-dialog {
			max-width: 100%;
			width: 100%;
			max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 24px);
			overflow: auto;
		}
		.feedback-dialog__head {
			gap: 8px;
		}
		.feedback-dialog__btn {
			width: 100%;
		}
		.feedback-dialog__btn,
		.feedback-dialog__icon {
			min-height: 44px;
			height: 44px;
		}
		.feedback-dialog__btn--primary {
			min-height: 44px;
		}
		.feedback-dialog__textarea {
			font-size: 16px;
		}
	}
	@media (max-width: 620px) {
		.feedback-backdrop {
			align-items: end;
			padding: 12px;
		}
		.feedback-dialog__actions {
			display: grid;
			grid-template-columns: 1fr 1fr;
		}
		.feedback-dialog__btn {
			min-height: 44px;
		}
		.feedback-dialog__icon {
			min-width: 44px;
			width: 44px;
		}
	}
</style>
