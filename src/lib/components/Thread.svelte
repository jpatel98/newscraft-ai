<script lang="ts">
	import type { ChatMessage, ContentPart, MessageContent } from '$lib/types';
	import { contentText } from '$lib/types';
	import Bot from 'lucide-svelte/icons/bot';
	import Copy from 'lucide-svelte/icons/copy';
	import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
	import Markdown from './Markdown.svelte';
	import ToolInspector, { type InspectorToolCall } from './ToolInspector.svelte';

	function parseToolCalls(m: ChatMessage): InspectorToolCall[] {
		// `messages.toolCalls` is a JSON column on the row but not part of the
		// ChatMessage type today. Read it best-effort; persistence isn't wired
		// yet (Hermes-side work) — when it lights up, the link/panel populate.
		const raw = (m as unknown as { toolCalls?: string | null }).toolCalls;
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
	function openInspector(m: ChatMessage) {
		inspectorCalls = parseToolCalls(m);
		inspectorOpen = true;
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

	$effect(() => {
		messages.length;
		const last = messages[messages.length - 1];
		if (last) lengthOf(last.content);
		queueMicrotask(() => {
			if (scroller) scroller.scrollTop = scroller.scrollHeight;
		});
	});

	function timeOf(_m: ChatMessage): string {
		const d = new Date();
		const h = d.getHours().toString().padStart(2, '0');
		const min = d.getMinutes().toString().padStart(2, '0');
		return `${h}:${min}`;
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

<div class="thread" bind:this={scroller}>
	<div class="thread__inner">
		{#each messages as m, i (m.id)}
			{@const prev = messages[i - 1]}
			{@const stacked = prev && prev.role === m.role}
			{@const roleChange = prev && prev.role !== m.role}
			<article
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
							{@const tc = parseToolCalls(m)}
							{#if tc.length > 0}
								<button type="button" class="msg__tools-link" onclick={() => openInspector(m)}>
									[{tc.length} {tc.length === 1 ? 'tool' : 'tools'}]
								</button>
							{/if}
						{/if}
					</div>

					<div class="msg__body" aria-live={m.role === 'assistant' && m.streaming ? 'polite' : 'off'}>
						{#if m.role === 'assistant' && m.streaming && lengthOf(m.content) === 0}
							<span class="pulse">
								<span class="pulse__dots" aria-hidden="true"
									><span></span><span></span><span></span></span
								>
								Drafting reply
							</span>
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
								class="msg__action"
								onclick={() => copy(m)}
								aria-label="Copy message"
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
