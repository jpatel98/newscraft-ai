<script lang="ts">
	import type { CitationRecord } from '@newscraft/shared';
	import DOMPurify from 'dompurify';
	import { onMount } from 'svelte';
	import { highlight } from '$lib/utils/highlight';
	import { prepareAssistantMarkdown, renderMarkdownToHtml } from '$lib/utils/markdown-render';
	import { isInspectableCitationRecord } from '$lib/utils/tool-metadata';

	interface Props {
		content: string;
		partial?: boolean;
		assistant?: boolean;
		citations?: ReadonlyArray<CitationRecord>;
		onCitationSelect?: (citation: CitationRecord, trigger: HTMLElement) => void;
	}
	let {
		content,
		partial = false,
		assistant = false,
		citations = [],
		onCitationSelect
	}: Props = $props();

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

	function restoreCitationMarkers() {
		if (!container) return;
		for (const marker of container.querySelectorAll<HTMLButtonElement>('.md-citation')) {
			const number = marker.dataset.citationNumber;
			if (number) marker.replaceWith(document.createTextNode(`[${number}]`));
		}
		container.normalize();
	}

	function decorateCitationMarkers() {
		if (!container) return;
		restoreCitationMarkers();
		if (partial || !onCitationSelect || citations.length === 0) return;

		const recordsByNumber = new Map<number, CitationRecord[]>();
		for (const citation of citations) {
			const records = recordsByNumber.get(citation.citationNumber) ?? [];
			records.push(citation);
			recordsByNumber.set(citation.citationNumber, records);
		}

		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

		for (const textNode of textNodes) {
			const parent = textNode.parentElement;
			if (!parent || parent.closest('a, button, code, pre, script, style, textarea')) continue;
			const text = textNode.data;
			const matches = Array.from(text.matchAll(/\[(\d+)\](?!\s*\()/g));
			if (matches.length === 0) continue;

			const fragment = document.createDocumentFragment();
			let cursor = 0;
			let replaced = false;
			for (const match of matches) {
				const index = match.index ?? 0;
				const number = Number(match[1]);
				const records = recordsByNumber.get(number) ?? [];
				if (
					text[index - 1] === '\\' ||
					records.length !== 1 ||
					!isInspectableCitationRecord(records[0])
				) {
					continue;
				}

				fragment.append(text.slice(cursor, index));
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'md-citation';
				button.dataset.citationNumber = String(number);
				button.textContent = `[${number}]`;
				button.setAttribute('aria-label', `Citation ${number}: ${records[0].title}`);
				button.title = `View evidence for citation ${number}`;
				button.addEventListener('click', () => onCitationSelect?.(records[0], button));
				fragment.append(button);
				cursor = index + match[0].length;
				replaced = true;
			}
			if (!replaced) continue;
			fragment.append(text.slice(cursor));
			textNode.replaceWith(fragment);
		}
	}

	$effect(() => {
		const _rendered = html;
		const _citations = citations;
		const _partial = partial;
		const _select = onCitationSelect;
		void _rendered;
		void _citations;
		void _partial;
		void _select;
		if (!mounted) return;
		queueMicrotask(decorateCitationMarkers);
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

<style>
	:global(.md .md-citation) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 20px;
		height: 19px;
		margin: 0 1px;
		padding: 0 3px;
		vertical-align: 0.16em;
		border: 1px solid var(--cobalt-200);
		border-radius: var(--radius-1);
		background: color-mix(in srgb, var(--cobalt-100) 62%, var(--bg-surface));
		color: var(--cobalt-700);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 650;
		line-height: 1;
		letter-spacing: 0;
		cursor: pointer;
	}

	:global(.md .md-citation:hover) {
		border-color: var(--cobalt-400);
		background: var(--cobalt-100);
		color: var(--cobalt-800);
	}

	:global(.md .md-citation:focus-visible) {
		outline: none;
		box-shadow: var(--shadow-focus);
	}
</style>
