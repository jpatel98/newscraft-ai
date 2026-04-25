<script lang="ts">
	import type { ChatMessage } from '$lib/types';
	import Bot from 'lucide-svelte/icons/bot';
	import Copy from 'lucide-svelte/icons/copy';
	import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
	import Markdown from './Markdown.svelte';

	interface Props {
		messages: ChatMessage[];
		userInitials?: string;
		onRegenerate?: () => void;
	}
	let { messages, userInitials = 'YOU', onRegenerate }: Props = $props();

	let scroller: HTMLDivElement | undefined = $state();
	let copied = $state<string | null>(null);

	$effect(() => {
		messages.length;
		messages[messages.length - 1]?.content.length;
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
			await navigator.clipboard.writeText(m.content);
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
		{#each messages as m (m.id)}
			<article class="msg">
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
						<span class="msg__name">
							{m.role === 'assistant' ? 'NewsCraft' : m.role === 'user' ? 'You' : m.role}
						</span>
						{#if m.role === 'assistant'}
							<span class="msg__app-tag">App</span>
						{/if}
						<span class="msg__time">{timeOf(m)}</span>
					</div>

					<div class="msg__body" aria-live={m.role === 'assistant' && m.partial ? 'polite' : 'off'}>
						{#if m.role === 'assistant' && m.partial && m.content.length === 0}
							<span class="pulse">
								<span class="pulse__dots" aria-hidden="true"
									><span></span><span></span><span></span></span
								>
								Drafting reply
							</span>
						{:else if m.role === 'assistant'}
							<Markdown content={m.content} partial={m.partial} />
							{#if m.partial}<span class="msg__caret" aria-hidden="true"></span>{/if}
						{:else}
							{m.content}{#if m.partial}<span class="msg__caret" aria-hidden="true"></span>{/if}
						{/if}
					</div>

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
