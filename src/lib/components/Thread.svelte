<script lang="ts">
	import type { ChatMessage } from '$lib/types';
	import Bot from 'lucide-svelte/icons/bot';

	interface Props {
		messages: ChatMessage[];
		userInitials?: string;
	}
	let { messages, userInitials = 'YOU' }: Props = $props();

	let scroller: HTMLDivElement | undefined;

	$effect(() => {
		// auto-scroll on any change to the last message length or count
		messages.length;
		messages[messages.length - 1]?.content.length;
		queueMicrotask(() => {
			if (scroller) scroller.scrollTop = scroller.scrollHeight;
		});
	});

	function timeOf(_m: ChatMessage): string {
		// no per-message timestamps from the server in v1; use a relative-now hint
		const d = new Date();
		const h = d.getHours().toString().padStart(2, '0');
		const min = d.getMinutes().toString().padStart(2, '0');
		return `${h}:${min}`;
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
					<div class="msg__avatar msg__avatar--user" aria-hidden="true">{m.role[0].toUpperCase()}</div>
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
						{:else}
							{m.content}{#if m.partial}<span class="msg__caret" aria-hidden="true"></span>{/if}
						{/if}
					</div>
				</div>
			</article>
		{/each}
	</div>
</div>
