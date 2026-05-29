import { atomAdapter } from './atom.js';
import { blueskyAdapter } from './bluesky.js';
import { htmlArticleAdapter } from './html-article.js';
import { pdfAdapter } from './pdf.js';
import { prWireAdapter } from './pr-wire.js';
import { rssAdapter } from './rss.js';
import { sitemapAdapter } from './sitemap.js';
import type { SourceAdapter, SourceAdapterInput } from './types.js';
import { webSearchAdapter } from './web-search.js';

export const SOURCE_ADAPTERS: SourceAdapter[] = [
	rssAdapter,
	atomAdapter,
	sitemapAdapter,
	webSearchAdapter,
	prWireAdapter,
	pdfAdapter,
	blueskyAdapter,
	htmlArticleAdapter
];

export function selectSourceAdapter(input: SourceAdapterInput): SourceAdapter {
	return SOURCE_ADAPTERS.find((adapter) => adapter.canHandle(input)) ?? htmlArticleAdapter;
}

export { atomAdapter } from './atom.js';
export { blueskyAdapter } from './bluesky.js';
export { htmlArticleAdapter } from './html-article.js';
export { pdfAdapter } from './pdf.js';
export { prWireAdapter } from './pr-wire.js';
export { rssAdapter } from './rss.js';
export { sitemapAdapter } from './sitemap.js';
export { webSearchAdapter } from './web-search.js';
export type {
	SourceAdapter,
	SourceAdapterDiff,
	SourceAdapterExtractInput,
	SourceAdapterInput,
	SourceAdapterKind,
	SourceArticleMetadata,
	SourceExtractionMethod,
	SourceItem,
	SourceProvenance
} from './types.js';
