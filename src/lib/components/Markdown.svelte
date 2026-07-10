<script lang="ts">
	import DOMPurify from 'dompurify';
	import { onMount } from 'svelte';
	import { highlight } from '$lib/utils/highlight';
	import { prepareAssistantMarkdown, renderMarkdownToHtml } from '$lib/utils/markdown-render';

	interface Props {
		content: string;
		partial?: boolean;
		assistant?: boolean;
	}
	let { content, partial = false, assistant = false }: Props = $props();

	const markdown = $derived(assistant ? prepareAssistantMarkdown(content) : content);

	const html = $derived.by(() => {
		try {
			const raw = renderMarkdownToHtml(markdown);
			if (typeof window === 'undefined') return raw; // Renderer escapes raw HTML before SSR.
			return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
		} catch {
			return '<p>(failed to render)</p>';
		}
	});

	let container: HTMLDivElement | undefined = $state();
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	// Highlight + decorate code blocks once streaming is done.
	$effect(() => {
		if (!mounted || !container || partial) return;
		const _ = html;
		const blocks = Array.from(container.querySelectorAll<HTMLPreElement>('pre > code'));
		if (blocks.length === 0) return;

		void Promise.all(
			blocks.map(async (codeEl) => {
				const pre = codeEl.parentElement as HTMLPreElement;
				if (pre.dataset.highlighted === '1') return;
				pre.dataset.highlighted = '1';

				const langClass = Array.from(codeEl.classList).find((c) => c.startsWith('language-'));
				const lang = langClass ? langClass.slice(9) : 'text';
				const text = codeEl.textContent ?? '';

				try {
					const highlighted = await highlight(text, lang, 'light');
					const wrapper = document.createElement('div');
					wrapper.innerHTML = highlighted;
					const newPre = wrapper.firstElementChild as HTMLPreElement | null;
					if (newPre) {
						newPre.classList.add('md-code');
						newPre.dataset.lang = lang;
						pre.replaceWith(newPre);
						decorate(newPre, text);
					}
				} catch {
					decorate(pre, text);
				}
			})
		);
	});

	function decorate(pre: HTMLPreElement, text: string) {
		if (pre.parentElement?.classList.contains('md-code-wrap')) return; // already wrapped

		const head = document.createElement('div');
		head.className = 'md-code__head';

		const lang = pre.dataset.lang || 'text';
		const tag = document.createElement('span');
		tag.className = 'md-code__lang';
		tag.textContent = lang;
		head.appendChild(tag);

		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'md-code__copy';
		btn.setAttribute('aria-label', 'Copy code');
		btn.textContent = 'Copy';
		btn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(text);
				btn.textContent = 'Copied';
				setTimeout(() => (btn.textContent = 'Copy'), 1200);
			} catch {
				btn.textContent = 'Failed';
			}
		});
		head.appendChild(btn);

		// Wrap the <pre> so the head sits OUTSIDE the horizontal scroll
		// container — otherwise scrolling the code drags the bar along with it.
		const wrap = document.createElement('div');
		wrap.className = 'md-code-wrap';
		const parent = pre.parentNode;
		if (!parent) return;
		parent.insertBefore(wrap, pre);
		wrap.appendChild(head);
		wrap.appendChild(pre);
	}
</script>

<div bind:this={container} class="md">
	{@html html}
</div>
