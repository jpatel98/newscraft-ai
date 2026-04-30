<script lang="ts">
	import type { ChatMessage, ContentPart, MessageContent } from '$lib/types';
	import { contentText } from '$lib/types';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import Copy from 'lucide-svelte/icons/copy';
	import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
	import Markdown from './Markdown.svelte';
	import ToolActivity from './ToolActivity.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import type { PersistedSource, StreamToolCall } from '$lib/utils/stream-events';
	import { formatShortTime } from '$lib/utils/time';
	import { parseToolMetadata, usedSources } from '$lib/utils/tool-metadata';
	import {
		formatElapsed,
		showToolRawName,
		toolStepDetail,
		toolStepLabel
	} from '$lib/utils/tool-labels';

	type ToolStepCall = Omit<StreamToolCall, 'status'> & {
		status?: 'running' | 'ok' | 'failed' | 'unknown';
	};

	function parseToolCalls(m: ChatMessage): ToolStepCall[] {
		return parseToolMetadata(m.toolCalls).tools.map((tool) => ({
			...tool,
			status: inspectorStatus(tool.status)
		}));
	}

	function parseMessageSources(m: ChatMessage): PersistedSource[] {
		return usedSources(parseToolMetadata(m.toolCalls).sources);
	}

	function inspectorStatus(status: string | undefined): ToolStepCall['status'] {
		const value = (status || 'unknown').toLowerCase();
		if (['running', 'started', 'start', 'active', 'queued', 'pending', 'in_progress'].includes(value)) {
			return 'running';
		}
		if (['ok', 'done', 'complete', 'completed', 'success'].includes(value)) return 'ok';
		if (['failed', 'failure', 'error', 'errored'].includes(value)) return 'failed';
		return 'unknown';
	}

	function liveSources(): PersistedSource[] {
		return usedSources(
			chat.sources.map((source) => ({
				id: source.id,
				url: source.url,
				title: source.title,
				status: source.status,
				domain: source.domain,
				detail: source.detail,
				firstSeenAt: source.firstSeenAt ?? source.updatedAt,
				lastSeenAt: source.lastSeenAt ?? source.updatedAt,
				used: source.used ?? true
			}))
		);
	}

	function sourcesForMessage(m: ChatMessage): PersistedSource[] {
		if (
			m.id === lastAssistantId &&
			conversationId != null &&
			chat.activityConversationId === conversationId &&
			(chat.streaming || chat.sources.length > 0)
		) {
			return liveSources();
		}
		if (m.role !== 'assistant') return [];
		return parseMessageSources(m);
	}

	function persistedStepCallsForMessage(m: ChatMessage): ToolStepCall[] {
		if (m.role !== 'assistant' || m.streaming) return [];
		if (
			m.id === lastAssistantId &&
			conversationId != null &&
			chat.activityConversationId === conversationId &&
			(chat.streaming || chat.tools.length > 0 || chat.toolHistory.length > 0)
		) {
			return [];
		}
		return parseToolCalls(m).filter((t) => t.status !== 'running');
	}

	function stepDuration(t: ToolStepCall): string {
		const ms =
			typeof t.durationMs === 'number'
				? t.durationMs
				: t.startedAt && t.endedAt
					? t.endedAt - t.startedAt
					: undefined;
		return typeof ms === 'number' && Number.isFinite(ms) ? formatElapsed(ms) : '';
	}

	let toolRecapExpanded = $state<Record<string, boolean>>({});
	let sourceStripExpanded = $state<Record<string, boolean>>({});
	function toggleToolRecap(id: string) {
		toolRecapExpanded = { ...toolRecapExpanded, [id]: !toolRecapExpanded[id] };
	}
	function toggleSourceStrip(id: string) {
		sourceStripExpanded = { ...sourceStripExpanded, [id]: !sourceStripExpanded[id] };
	}

	interface Props {
		messages: ChatMessage[];
		conversationId?: string | null;
		userInitials?: string;
		onRegenerate?: () => void;
		onResume?: (messageId: string) => void;
		onDiscard?: (messageId: string) => void;
	}
	let {
		messages,
		conversationId = null,
		userInitials = 'YOU',
		onRegenerate,
		onResume,
		onDiscard
	}: Props = $props();

	let scroller: HTMLDivElement | undefined = $state();
	let copied = $state<string | null>(null);
	let scrolledToHash = $state(false);
	// Track conversation by the first message id; switching threads resets
	// the initial-scroll machinery so a fresh open always lands deterministically.
	let conversationKey = $state<string | null>(null);
	let didInitialScroll = $state(false);
	let hashMessageId = $state<string | null>(null);
	// Stay glued to the bottom while streaming, but only when the user hasn't
	// scrolled up to read history. Default true so the first stream tail-follows.
	let stickToBottom = $state(true);

	const THREAD_CONTAINMENT_THRESHOLD = 80;
	const UNCONTAINED_TAIL_COUNT = 12;
	const deferredBeforeIndex = $derived(
		messages.length >= THREAD_CONTAINMENT_THRESHOLD
			? Math.max(0, messages.length - UNCONTAINED_TAIL_COUNT)
			: 0
	);

	function lengthOf(c: MessageContent): number {
		return typeof c === 'string' ? c.length : c.length;
	}
	function textOf(c: MessageContent): string {
		return typeof c === 'string' ? c : contentText(c);
	}
	function partsOf(c: MessageContent): ContentPart[] {
		if (typeof c === 'string') return [{ type: 'text', text: c }];
		return c;
	}

	function isNearBottom(): boolean {
		if (!scroller) return true;
		return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
	}

	function scrollToBottom(): void {
		if (!scroller) return;
		scroller.scrollTop = scroller.scrollHeight;
	}

	function onScroll(): void {
		stickToBottom = isNearBottom();
	}

	function messageIdFromHash(): string | null {
		if (typeof location === 'undefined') return null;
		const match = location.hash.match(/^#m=(.+)$/);
		if (!match) return null;
		try {
			return decodeURIComponent(match[1]);
		} catch {
			return null;
		}
	}

	function shouldDeferMessage(m: ChatMessage, index: number): boolean {
		if (index >= deferredBeforeIndex) return false;
		if (m.streaming || m.id === hashMessageId) return false;
		return true;
	}

	// Reset initial-scroll state when switching conversations (first message id
	// changes). Without this, navigating from one thread to another would keep
	// the previous scroll position instead of landing at the latest message.
	$effect(() => {
		const key = messages[0]?.id ?? null;
		if (key !== conversationKey) {
			conversationKey = key;
			didInitialScroll = false;
			scrolledToHash = false;
			hashMessageId = null;
			toolRecapExpanded = {};
			sourceStripExpanded = {};
			stickToBottom = true;
		}
	});

	$effect(() => {
		// Track length AND the tail's content length so streaming token-by-token
		// triggers re-evaluation and tail-follow scroll.
		messages.length;
		const last = messages[messages.length - 1];
		if (last) lengthOf(last.content);

		if (!scroller) return;

		if (!didInitialScroll) {
			const hashId = messageIdFromHash();
			hashMessageId = hashId;
			// Two rAFs let markdown + late-loading images settle before we measure
			// scrollHeight; a 60ms re-anchor catches images that decode after that.
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					if (hashId && !scrolledToHash) {
						const el = document.getElementById(`m-${hashId}`);
						if (el) {
							el.scrollIntoView({ block: 'center' });
							scrolledToHash = true;
							didInitialScroll = true;
							return;
						}
					}
					scrollToBottom();
					setTimeout(scrollToBottom, 60);
					didInitialScroll = true;
				})
			);
			return;
		}

		if (stickToBottom) queueMicrotask(scrollToBottom);
	});

	function timeOf(m: ChatMessage): string {
		const ts = (m as ChatMessage & { createdAt?: number }).createdAt ?? Date.now();
		return formatShortTime(ts);
	}

	const lastAssistantId = $derived.by(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant') return messages[i].id;
		}
		return null;
	});

	async function copy(m: ChatMessage) {
		try {
			await navigator.clipboard.writeText(textOf(m.content));
			copied = m.id;
			setTimeout(() => {
				if (copied === m.id) copied = null;
			}, 1200);
		} catch {
			/* clipboard denied — silently no-op */
		}
	}
</script>

<div
	class="thread {deferredBeforeIndex > 0 ? 'thread--contained' : ''}"
	bind:this={scroller}
	onscroll={onScroll}
>
	<div class="thread__inner">
		{#each messages as m, i (m.id)}
			{@const prev = messages[i - 1]}
			{@const stacked = prev && prev.role === m.role}
			{@const roleChange = prev && prev.role !== m.role}
			{@const deferred = shouldDeferMessage(m, i)}
			<article
				id={`m-${m.id}`}
				class="msg msg--{m.role} {stacked ? 'msg--stacked' : ''} {roleChange
					? 'msg--role-change'
					: ''} {deferred ? 'msg--deferred' : ''}"
			>
				{#if m.role === 'assistant'}
					<div class="msg__avatar msg__avatar--bot" aria-hidden="true">
						<img class="msg__avatar-img" src="/brand/newscraft-agent-avatar.png" alt="" />
					</div>
				{:else if m.role === 'user'}
					<div class="msg__avatar msg__avatar--user" aria-hidden="true">{userInitials}</div>
				{:else}
					<div class="msg__avatar msg__avatar--user" aria-hidden="true">
						{m.role[0].toUpperCase()}
					</div>
				{/if}
				<div>
					<div class="msg__head">
						{#if m.role === 'assistant'}
							<span class="msg__app-tag">NewsCraft AI</span>
						{/if}
						<span class="msg__time">{timeOf(m)}</span>
					</div>

					<div class="msg__body" aria-live={m.role === 'assistant' && m.streaming ? 'polite' : 'off'}>
						{#if m.role === 'assistant' && m.streaming && lengthOf(m.content) === 0}
							<!-- Empty streaming state intentionally renders nothing here; the
							   ToolActivity card below shows the live "Drafting answer" pulse.
							   That avoids two pulses competing for the same moment. -->
						{:else if m.role === 'assistant'}
							<Markdown content={textOf(m.content)} partial={m.streaming === true} />
							{#if m.streaming}<span class="msg__caret" aria-hidden="true"></span>{/if}
							{#if m.partial && !m.streaming}
								<span
									style="display:inline-block;margin-left:6px;font-family:var(--font-mono);font-size:10.5px;color:var(--fg-3);text-transform:uppercase;letter-spacing:0.04em"
								>
									— interrupted
								</span>
							{/if}
						{:else if Array.isArray(m.content)}
							{#each partsOf(m.content) as p, pi (pi)}
								{#if p.type === 'text'}
									{p.text}
								{:else if p.type === 'image_url'}
									<a
										class="msg__img-link"
										href={p.image_url.url}
										target="_blank"
										rel="noopener noreferrer"
									>
										<img class="msg__img" src={p.image_url.url} alt="attachment" />
									</a>
								{/if}
							{/each}
							{#if m.streaming}<span class="msg__caret" aria-hidden="true"></span>{/if}
						{:else}
							{m.content}{#if m.streaming}<span class="msg__caret" aria-hidden="true"></span>{/if}
						{/if}
					</div>

					{#if m.role === 'assistant'}
						{@const sources = sourcesForMessage(m)}
						{#if sources.length > 0}
							{@const sourceOpen = !!sourceStripExpanded[m.id]}
							{@const visibleSources = sourceOpen ? sources : sources.slice(0, 4)}
							<div class="msg__sources" aria-label="Sources used">
								<span class="msg__sources__label">Sources</span>
								<div class="msg__sources__list">
									{#each visibleSources as source (source.url)}
										<a
											class="msg-source"
											href={source.url}
											target="_blank"
											rel="noopener noreferrer"
											title={source.title}
										>
											<span class="msg-source__domain">{source.domain}</span>
											<span class="msg-source__title">{source.title}</span>
										</a>
									{/each}
									{#if sources.length > 4}
										<button
											type="button"
											class="msg-source msg-source--more"
											onclick={() => toggleSourceStrip(m.id)}
											aria-expanded={sourceOpen}
										>
											{sourceOpen ? 'Show fewer' : `+${sources.length - 4} more`}
										</button>
									{/if}
								</div>
							</div>
						{/if}
					{/if}

					{#if m.role === 'assistant'}
						{@const persistedSteps = persistedStepCallsForMessage(m)}
						{#if persistedSteps.length > 0}
							{@const recapOpen = !!toolRecapExpanded[m.id]}
							<div class="msg__tool-recap" aria-label="Completed tool steps">
								<div class="msg__tool-recap__head">
									<button
										type="button"
										class="msg__tool-recap__toggle"
										onclick={() => toggleToolRecap(m.id)}
										aria-expanded={recapOpen}
									>
										<ChevronRight
											class="msg__tool-recap__chev {recapOpen
												? 'msg__tool-recap__chev--open'
												: ''}"
											size="12"
											strokeWidth={1.75}
										/>
										<span>{persistedSteps.length === 1 ? 'Task completed' : 'Tasks completed'}</span>
										<span class="msg__tool-recap__count">
											· {persistedSteps.length} {persistedSteps.length === 1 ? 'step' : 'steps'}
										</span>
									</button>
								</div>
								{#if recapOpen}
									<ol class="msg__tool-recap__list">
										{#each persistedSteps as t, ti (t.id)}
											{@const detail = toolStepDetail(t)}
											{@const duration = stepDuration(t)}
											<li
												class="msg__tool-step {t.status === 'failed'
													? 'msg__tool-step--failed'
													: ''}"
											>
												<span class="msg__tool-step__index">{ti + 1}</span>
												<span class="msg__tool-step__main">
													<span class="msg__tool-step__row">
														<span class="msg__tool-step__name">{toolStepLabel(t, true)}</span>
														{#if showToolRawName(t)}
															<span class="msg__tool-step__raw">{t.name}</span>
														{/if}
													</span>
													{#if detail}
														<span class="msg__tool-step__detail">{detail}</span>
													{/if}
												</span>
												{#if duration}
													<span class="msg__tool-step__duration">{duration}</span>
												{/if}
											</li>
										{/each}
									</ol>
								{/if}
							</div>
						{/if}
					{/if}

					{#if m.role === 'assistant' && m.id === lastAssistantId && chat.activityConversationId === conversationId}
						<ToolActivity activeTurn={true} />
					{/if}

					{#if m.role === 'assistant' && m.partial && !m.streaming && !m.id.startsWith('tmp-')}
						<div class="msg__resume" role="status">
							<span class="msg__resume__label">Stream interrupted</span>
							{#if onResume}
								<button
									type="button"
									class="msg__resume__btn msg__resume__btn--primary"
									onclick={() => onResume?.(m.id)}
								>
									Resume
								</button>
							{/if}
							{#if onDiscard}
								<button
									type="button"
									class="msg__resume__btn"
									onclick={() => onDiscard?.(m.id)}
								>
									Discard
								</button>
							{/if}
						</div>
					{/if}

					{#if !m.partial && (m.role === 'assistant' || m.role === 'user')}
						<div class="msg__actions">
							<button
								type="button"
								class="msg__action {copied === m.id ? 'msg__action--success' : ''}"
								onclick={() => copy(m)}
								aria-label={copied === m.id ? 'Message copied' : 'Copy message'}
							>
								<Copy size="11" strokeWidth={1.5} />
								<span>{copied === m.id ? 'Copied' : 'Copy'}</span>
							</button>
							{#if m.role === 'assistant' && m.id === lastAssistantId && onRegenerate}
								<button
									type="button"
									class="msg__action"
									onclick={() => onRegenerate?.()}
									aria-label="Regenerate reply"
									title="Regenerate reply"
								>
									<RotateCcw size="11" strokeWidth={1.5} />
									<span>Regenerate</span>
								</button>
							{/if}
						</div>
					{/if}
				</div>
			</article>
		{/each}
	</div>
</div>

<style>
	.thread--contained .msg--deferred {
		content-visibility: auto;
		contain-intrinsic-size: auto 120px;
	}
	.thread--contained .msg--deferred.msg--assistant {
		contain-intrinsic-size: auto 220px;
	}
	.thread--contained .msg--deferred.msg--user {
		contain-intrinsic-size: auto 72px;
	}

	:global(.msg__img-link) {
		display: inline-block;
		margin: 6px 6px 0 0;
	}
	:global(.msg__img) {
		max-width: 320px;
		max-height: 320px;
		width: auto;
		height: auto;
		display: block;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		cursor: zoom-in;
		background: var(--bg-raised);
	}
</style>
