import type { PoliteFetchCacheMetadata, PoliteFetchOptions, PoliteFetchResult } from '../polite-fetch.js';

export type SourceAdapterKind =
	| 'rss'
	| 'atom'
	| 'sitemap'
	| 'web_search'
	| 'pr_wire'
	| 'pdf'
	| 'api_bluesky'
	| 'html_article';

export interface SourceProvenance {
	adapter: SourceAdapterKind;
	sourceUrl: string;
	discoveredAt: string;
	fetchedAt?: string;
	parentUrl?: string;
	contentType?: string | null;
	statusCode?: number | null;
	contentHash?: string | null;
	etag?: string | null;
	lastModified?: string | null;
}

export interface SourceItem {
	id: string;
	url: string;
	title: string;
	summary: string;
	contentText: string;
	publishedAt: string | null;
	updatedAt: string | null;
	provenance: SourceProvenance;
}

export interface SourceAdapterInput {
	url: string;
	contentType: string | null;
	body?: string;
}

export interface SourceAdapterExtractInput {
	url: string;
	body: string;
	contentType: string | null;
	fetchedAt: string;
	statusCode: number | null;
	contentHash: string | null;
	cache?: PoliteFetchCacheMetadata;
}

export interface SourceAdapterDiff {
	added: SourceItem[];
	updated: SourceItem[];
	removed: SourceItem[];
	unchanged: SourceItem[];
}

export interface SourceAdapter {
	kind: SourceAdapterKind;
	canHandle(input: SourceAdapterInput): boolean;
	fetch(url: string, options?: PoliteFetchOptions): Promise<PoliteFetchResult>;
	discover(input: SourceAdapterExtractInput): SourceItem[] | Promise<SourceItem[]>;
	extract(input: SourceAdapterExtractInput): SourceItem[] | Promise<SourceItem[]>;
	diff(previous: SourceItem[], next: SourceItem[]): SourceAdapterDiff;
}
