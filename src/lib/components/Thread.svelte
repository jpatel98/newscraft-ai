<script lang="ts">
	import type { ChatMessage } from '$lib/types';

	interface Props {
		messages: ChatMessage[];
	}
	let { messages }: Props = $props();

	let scroller: HTMLDivElement | undefined;

	$effect(() => {
		// crude auto-scroll: any change in messages or last content length scrolls
		messages.length;
		messages[messages.length - 1]?.content.length;
		queueMicrotask(() => {
			if (scroller) scroller.scrollTop = scroller.scrollHeight;
		});
	});
</script>

<div bind:this={scroller} style="flex:1;overflow:auto;padding:1.5rem 1rem">
	<div style="max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:1rem">
		{#each messages as m (m.id)}
			<div style="display:flex;flex-direction:column;gap:0.25rem">
				<div style="font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.04em">
					{m.role}
				</div>
				<div
					style="white-space:pre-wrap;line-height:1.55;color:#111;background:{m.role === 'user'
						? '#f4f4f6'
						: 'transparent'};padding:{m.role === 'user' ? '0.6rem 0.8rem' : '0'};border-radius:6px"
				>
					{m.content}{#if m.partial}<span style="opacity:0.4">▍</span>{/if}
				</div>
			</div>
		{/each}
	</div>
</div>
