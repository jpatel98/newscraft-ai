import { marked } from 'marked';

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);

const GENERATED_TAIL_PATTERNS = [
	/(?:^|\n)\s*(?:#{1,6}\s*)?(?:implementation details?|debug details?|tool trace|json log)\b\s*:?\s*(?:\n|$)[\s\S]*$/i,
	/(?:^|\n)\s*Link extraction was incomplete[^\n]*(?:\n[\s\S]*)?$/i,
	/(?:^|\n)\s*If you(?:'|’)d like,\s*(?:the )?next step can be[\s\S]*$/i,
	/(?:^|\n)\s*(?:Would you like|Do you want) (?:me )?to[\s\S]*$/i
];

export function prepareAssistantMarkdown(content: string): string {
	return stripGeneratedAssistantTail(content)
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function stripGeneratedAssistantTail(content: string): string {
	let next = content;
	for (const pattern of GENERATED_TAIL_PATTERNS) next = next.replace(pattern, '\n');
	return next;
}

export function renderMarkdownToHtml(content: string): string {
	return marked.parse(content, {
		async: false,
		breaks: true,
		gfm: true,
		renderer: createRenderer()
	}) as string;
}

function createRenderer() {
	const renderer = new marked.Renderer();
	const defaultLinkRenderer = renderer.link.bind(renderer);
	const defaultImageRenderer = renderer.image.bind(renderer);

	renderer.link = (token) => {
		const text = tokenText(token.tokens);
		if (!isSafeHref(token.href)) return escapeHtml(text || token.href);

		const rendered = defaultLinkRenderer(token);
		const bareLabel = compactBareUrlLabel(token.href, text);
		if (!bareLabel) return rendered;

		const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
		return `<a class="md-source-link" href="${escapeHtml(token.href)}"${title}>${escapeHtml(bareLabel)}</a>`;
	};

	renderer.image = (token) => {
		if (!isSafeImageHref(token.href)) return escapeHtml(token.text || token.href);
		return defaultImageRenderer(token);
	};

	renderer.html = (token) => escapeHtml(token.text);

	return renderer;
}

function tokenText(tokens: unknown[]): string {
	return tokens
		.map((token) => {
			if (!token || typeof token !== 'object') return '';
			if ('text' in token && typeof token.text === 'string') return token.text;
			if ('tokens' in token && Array.isArray(token.tokens)) return tokenText(token.tokens);
			return '';
		})
		.join('');
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function parsedUrl(raw: string): URL | null {
	try {
		return new URL(raw, 'https://newscraft.local');
	} catch {
		return null;
	}
}

function isSafeHref(raw: string): boolean {
	const url = parsedUrl(raw);
	return !!url && SAFE_LINK_PROTOCOLS.has(url.protocol);
}

function isSafeImageHref(raw: string): boolean {
	const url = parsedUrl(raw);
	return !!url && SAFE_IMAGE_PROTOCOLS.has(url.protocol);
}

function compactBareUrlLabel(href: string, text: string): string {
	if (!text) return '';
	const url = parsedUrl(href);
	if (!url || url.origin === 'https://newscraft.local') return '';
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
	const isTextUrl = text === href || text.replace(/^https?:\/\//, '') === href.replace(/^https?:\/\//, '');
	if (!isTextUrl) return '';

	const host = url.hostname.replace(/^www\./, '');
	const path = url.pathname === '/' ? '' : url.pathname;
	const full = `${host}${path}`;
	return full.length > 56 ? `${full.slice(0, 56)}...` : full;
}
