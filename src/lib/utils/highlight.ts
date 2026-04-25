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
		try {
			const grammar = await import(`shiki/langs/${safeLang}.mjs`);
			await hl.loadLanguage(grammar.default);
			loadedLangs.add(safeLang);
		} catch {
			// fallback to plain text on grammar load failure
		}
	}

	const themeName: BundledTheme = (theme === 'dark' ? 'github-dark' : 'github-light') as BundledTheme;
	return hl.codeToHtml(code, {
		lang: loadedLangs.has(safeLang) ? safeLang : 'text',
		theme: themeName
	});
}
