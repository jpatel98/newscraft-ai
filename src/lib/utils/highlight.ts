// Lazy Shiki highlighter. Loaded on first code block render only.
// One highlighter is reused across calls; languages are loaded on demand.

import type { HighlighterCore, BundledLanguage, BundledTheme } from 'shiki';

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();

async function getHighlighter(): Promise<HighlighterCore> {
	if (highlighterPromise) return highlighterPromise;
	highlighterPromise = (async () => {
		const { createHighlighterCore } = await import('shiki/core');
		const { createOnigurumaEngine } = await import('shiki/engine/oniguruma');
		const light = (await import('shiki/themes/github-light.mjs')).default;
		const dark = (await import('shiki/themes/github-dark.mjs')).default;
		return createHighlighterCore({
			themes: [light, dark],
			langs: [],
			engine: createOnigurumaEngine(import('shiki/wasm'))
		});
	})();
	return highlighterPromise;
}

const KNOWN: Set<string> = new Set([
	'bash',
	'sh',
	'js',
	'javascript',
	'ts',
	'typescript',
	'json',
	'yaml',
	'toml',
	'python',
	'py',
	'go',
	'rust',
	'rs',
	'sql',
	'html',
	'css',
	'scss',
	'svelte',
	'jsx',
	'tsx',
	'md',
	'markdown',
	'diff',
	'dockerfile',
	'lua',
	'java',
	'c',
	'cpp',
	'csharp',
	'php',
	'ruby',
	'swift',
	'kotlin',
	'r',
	'xml'
]);

const ALIAS: Record<string, string> = {
	js: 'javascript',
	ts: 'typescript',
	py: 'python',
	rs: 'rust',
	sh: 'bash',
	md: 'markdown'
};

const LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
	bash: () => import('shiki/langs/bash.mjs'),
	sh: () => import('shiki/langs/bash.mjs'),
	js: () => import('shiki/langs/javascript.mjs'),
	javascript: () => import('shiki/langs/javascript.mjs'),
	ts: () => import('shiki/langs/typescript.mjs'),
	typescript: () => import('shiki/langs/typescript.mjs'),
	json: () => import('shiki/langs/json.mjs'),
	yaml: () => import('shiki/langs/yaml.mjs'),
	toml: () => import('shiki/langs/toml.mjs'),
	python: () => import('shiki/langs/python.mjs'),
	py: () => import('shiki/langs/python.mjs'),
	go: () => import('shiki/langs/go.mjs'),
	rust: () => import('shiki/langs/rust.mjs'),
	rs: () => import('shiki/langs/rust.mjs'),
	sql: () => import('shiki/langs/sql.mjs'),
	html: () => import('shiki/langs/html.mjs'),
	css: () => import('shiki/langs/css.mjs'),
	scss: () => import('shiki/langs/scss.mjs'),
	svelte: () => import('shiki/langs/svelte.mjs'),
	jsx: () => import('shiki/langs/jsx.mjs'),
	tsx: () => import('shiki/langs/tsx.mjs'),
	md: () => import('shiki/langs/markdown.mjs'),
	markdown: () => import('shiki/langs/markdown.mjs'),
	diff: () => import('shiki/langs/diff.mjs'),
	dockerfile: () => import('shiki/langs/dockerfile.mjs'),
	lua: () => import('shiki/langs/lua.mjs'),
	java: () => import('shiki/langs/java.mjs'),
	c: () => import('shiki/langs/c.mjs'),
	cpp: () => import('shiki/langs/cpp.mjs'),
	csharp: () => import('shiki/langs/csharp.mjs'),
	php: () => import('shiki/langs/php.mjs'),
	ruby: () => import('shiki/langs/ruby.mjs'),
	swift: () => import('shiki/langs/swift.mjs'),
	kotlin: () => import('shiki/langs/kotlin.mjs'),
	r: () => import('shiki/langs/r.mjs'),
	xml: () => import('shiki/langs/xml.mjs')
};

export async function highlight(
	code: string,
	lang: string,
	theme: 'light' | 'dark'
): Promise<string> {
	const normalised = (ALIAS[lang] || lang || 'text').toLowerCase();
	const safeLang: BundledLanguage | 'text' = (KNOWN.has(normalised) ? normalised : 'text') as
		| BundledLanguage
		| 'text';

	const hl = await getHighlighter();

	if (safeLang !== 'text' && !loadedLangs.has(safeLang)) {
		const loader = LANG_LOADERS[safeLang];
		if (loader) {
			try {
				const grammar = await loader();
				await hl.loadLanguage(grammar.default as Parameters<typeof hl.loadLanguage>[0]);
				loadedLangs.add(safeLang);
			} catch {
				// fallback to plain text on grammar load failure
			}
		}
	}

	const themeName: BundledTheme = (theme === 'dark' ? 'github-dark' : 'github-light') as BundledTheme;
	return hl.codeToHtml(code, {
		lang: loadedLangs.has(safeLang) ? safeLang : 'text',
		theme: themeName
	});
}
