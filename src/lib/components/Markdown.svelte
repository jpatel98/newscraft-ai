<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { onMount } from 'svelte';
	import Copy from 'lucide-svelte/icons/copy';
	import Check from 'lucide-svelte/icons/check';
	import { highlight } from '$lib/utils/highlight';

	interface Props {
		content: string;
		partial?: boolean;
	}
	let { content, partial = false }: Props = $props();

	const renderer = new marked.Renderer();
	const defaultLinkRenderer = renderer.link.bind(renderer);
	const defaultImageRenderer = renderer.image.bind(renderer);

	function escapeHtml(s: string): string {
		return s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function safeUrl(raw: string): URL | null {
		try {
			return new URL(raw, 'https://newscraft.local');
		} catch {
			return null;
		}
	}

	function isSafeHref(raw: string): boolean {
		const url = safeUrl(raw);
		return !!url && ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol);
	}

	renderer.link = (token) => {
		const text = token.tokens
			.map((t) => ('text' in t && typeof t.text === 'string' ? t.text : ''))
			.join('');
		if (!isSafeHref(token.href)) return escapeHtml(text || token.href);
		const rendered = defaultLinkRenderer(token);
		try {
			const url = new URL(token.href);
			const isTextUrl =
				text === token.href ||
				text.replace(/^https?:\/\//, '') === token.href.replace(/^https?:\/\//, '');
			if (!isTextUrl) return rendered;
			const host = url.hostname.replace(/^www\./, '');
			const path = url.pathname === '/' ? '' : url.pathname;
			const full = `${host}${path}`;
			const label = full.length > 56 ? full.slice(0, 56) + '…' : full;
			const html = defaultLinkRenderer({
				...token,
				tokens: [{ type: 'text', raw: label, text: label }]
			});
			// Inject a class so the host-only rendering can be styled compactly
			// (smaller, mono-ish) without competing with body prose.
			return html.replace(/^<a /, '<a class="md-source-link" ');
		} catch {
			return rendered;
		}
	};
	renderer.image = (token) => {
		if (!isSafeHref(token.href)) return escapeHtml(token.text || token.href);
		return defaultImageRenderer(token);
	};
	renderer.html = (token) => escapeHtml(token.text);

	marked.setOptions({ gfm: true, breaks: true, renderer });

	const html = $derived.by(() => {
		try {
			const raw = marked.parse(content, { async: false }) as string;
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
