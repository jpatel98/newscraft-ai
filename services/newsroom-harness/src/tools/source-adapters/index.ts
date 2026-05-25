import { atomAdapter } from './atom.js';
import { htmlArticleAdapter } from './html-article.js';
import { rssAdapter } from './rss.js';
import { sitemapAdapter } from './sitemap.js';
import type { SourceAdapter, SourceAdapterInput } from './types.js';

export const SOURCE_ADAPTERS: SourceAdapter[] = [rssAdapter, atomAdapter, sitemapAdapter, htmlArticleAdapter];

export function selectSourceAdapter(input: SourceAdapterInput): SourceAdapter {
	return SOURCE_ADAPTERS.find((adapter) => adapter.canHandle(input)) ?? htmlArticleAdapter;
}

export { atomAdapter } from './atom.js';
export { htmlArticleAdapter } from './html-article.js';
export { rssAdapter } from './rss.js';
export { sitemapAdapter } from './sitemap.js';
export type {
	SourceAdapter,
	SourceAdapterDiff,
	SourceAdapterExtractInput,
	SourceAdapterInput,
	SourceAdapterKind,
	SourceItem,
	SourceProvenance
} from './types.js';
