<script lang="ts">
	import type { ChatMessage, ContentPart, MessageContent } from '$lib/types';
	import { contentText } from '$lib/types';
	import Bot from 'lucide-svelte/icons/bot';
	import Copy from 'lucide-svelte/icons/copy';
	import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
	import Markdown from './Markdown.svelte';
	import ToolActivity from './ToolActivity.svelte';
	import ToolInspector, { type InspectorToolCall } from './ToolInspector.svelte';
	import { chat, type ToolHistoryEntry, type ToolProgress } from '$lib/stores/chat.svelte';
	import { formatShortTime } from '$lib/utils/time';

	function parseToolCalls(m: ChatMessage): InspectorToolCall[] {
		const raw = m.toolCalls;
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.map((c, i) => {
				const o = (c ?? {}) as Record<string, unknown>;
				return {
					id: String(o.id ?? `${m.id}-${i}`),
					name: String(o.name ?? 'tool'),
					status: (o.status as InspectorToolCall['status']) ?? 'unknown',
					startedAt: typeof o.startedAt === 'number' ? o.startedAt : undefined,
					endedAt: typeof o.endedAt === 'number' ? o.endedAt : undefined,
					durationMs: typeof o.durationMs === 'number' ? o.durationMs : undefined,
					arguments: o.arguments,
					result: o.result,
					transcript: typeof o.transcript === 'string' ? o.transcript : undefined
				};
			});
		} catch {
			return [];
		}
	}

	let inspectorOpen = $state(false);
	let inspectorCalls = $state<InspectorToolCall[]>([]);
	function openInspector(calls: InspectorToolCall[]) {
		inspectorCalls = calls;
		inspectorOpen = true;
	}

	function inspectorStatus(status: string | undefined): InspectorToolCall['status'] {
		const value = (status || 'unknown').toLowerCase();
		if (['running', 'started', 'start', 'active', 'queued', 'pending', 'in_progress'].includes(value)) {
			return 'running';
		}
		if (['ok', 'done', 'complete', 'completed', 'success'].includes(value)) return 'ok';
		if (['failed', 'failure', 'error', 'errored'].includes(value)) return 'failed';
		return 'unknown';
	}

	function liveToolCall(t: ToolProgress | ToolHistoryEntry, statusOverride?: string): InspectorToolCall {
		const endedAt = 'finishedAt' in t ? t.finishedAt : t.endedAt;
		return {
			id: t.id,
			name: t.name,
			status: inspectorStatus(statusOverride ?? t.status),
			startedAt: t.startedAt,
			endedAt,
			durationMs: 'durationMs' in t ? t.durationMs : endedAt ? endedAt - t.startedAt : undefined,
			arguments: t.arguments,
			result: t.result,
			transcript: t.transcript
		};
	}

	function liveToolCalls(): InspectorToolCall[] {
		return [
			...chat.tools.map((tool) => liveToolCall(tool, 'running')),
			...chat.toolHistory.map((tool) => liveToolCall(tool))
		];
	}

	function toolCallsForMessage(m: ChatMessage): InspectorToolCall[] {
		const live = m.id === lastAssistantId ? liveToolCalls() : [];
		return live.length ? live : parseToolCalls(m);
	}

	interface Props {
		messages: ChatMessage[];
		userInitials?: string;
		onRegenerate?: () => void;
		onResume?: (messageId: string) => void;
		onDiscard?: (messageId: string) => void;
	}
	let { messages, userInitials = 'YOU', onRegenerate, onResume, onDiscard }: Props = $props();

	let scroller: HTMLDivElement | undefined = $state();
	let copied = $state<string | null>(null);
	let scrolledToHash = $state(false);
	// Track conversation by the first message id; switching threads resets
	// the initial-scroll machinery so a fresh open always lands deterministically.
	let conversationKey = $state<string | null>(null);
	let didInitialScroll = $state(false);
	// Stay glued to the bottom while streaming, but only when the user hasn't
	// scrolled up to read history. Default true so the first stream tail-follows.
	let stickToBottom = $state(true);

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

	// Reset initial-scroll state when switching conversations (first message id
	// changes). Without this, navigating from one thread to another would keep
	// the previous scroll position instead of landing at the latest message.
	$effect(() => {
		const key = messages[0]?.id ?? null;
		if (key !== conversationKey) {
			conversationKey = key;
			didInitialScroll = false;
			scrolledToHash = false;
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
			const hashMatch =
				typeof location === 'undefined' ? null : location.hash.match(/^#m=(.+)$/);
			// Two rAFs let markdown + late-loading images settle before we measure
			// scrollHeight; a 60ms re-anchor catches images that decode after that.
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					if (hashMatch && !scrolledToHash) {
						const el = document.getElementById(`m-${decodeURIComponent(hashMatch[1])}`);
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

<div class="thread" bind:this={scroller} onscroll={onScroll}>
	<div class="thread__inner">
		{#each messages as m, i (m.id)}
			{@const prev = messages[i - 1]}
			{@const stacked = prev && prev.role === m.role}
			{@const roleChange = prev && prev.role !== m.role}
			<article
				id={`m-${m.id}`}
				class="msg msg--{m.role} {stacked ? 'msg--stacked' : ''} {roleChange ? 'msg--role-change' : ''}"
			>
				{#if m.role === 'assistant'}
					<div class="msg__avatar msg__avatar--bot" aria-hidden="true">
						<Bot size="18" strokeWidth={1.5} color="#FBFAF7" />
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
							<span class="msg__app-tag">App</span>
						{/if}
						<span class="msg__time">{timeOf(m)}</span>
						{#if m.role === 'assistant'}
							{@const tc = toolCallsForMessage(m)}
							{#if tc.length > 0}
								<button type="button" class="msg__tools-link" onclick={() => openInspector(tc)}>
									[{tc.length} {tc.length === 1 ? 'tool' : 'tools'}]
								</button>
							{/if}
						{/if}
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

					{#if m.role === 'assistant' && m.id === lastAssistantId}
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

<ToolInspector toolCalls={inspectorCalls} open={inspectorOpen} onClose={() => (inspectorOpen = false)} />

<style>
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
