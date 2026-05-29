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

export type SourceExtractionMethod =
	| 'json_ld_article_body'
	| 'schema_article_body'
	| 'readability'
	| 'metadata_summary_fallback';

export interface SourceArticleMetadata {
	title?: string | null;
	description?: string | null;
	canonicalUrl?: string | null;
	siteName?: string | null;
	publishedAt?: string | null;
	updatedAt?: string | null;
	authors?: string[];
	image?: string | null;
	section?: string | null;
	keywords?: string[];
	structuredType?: string | null;
	metadataSources?: string[];
}

export interface SourceProvenance {
	adapter: SourceAdapterKind;
	sourceUrl: string;
	discoveredAt: string;
	fetchedAt?: string;
	parentUrl?: string;
	contentType?: string | null;
	statusCode?: number | null;
	contentHash?: string | null;
	archiveSnapshotUrl?: string | null;
	etag?: string | null;
	lastModified?: string | null;
	extractionMethod?: SourceExtractionMethod | null;
	metadataSources?: string[] | null;
	structuredType?: string | null;
	canonicalUrl?: string | null;
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
	metadata?: SourceArticleMetadata | null;
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
	archiveSnapshotUrl?: string | null;
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
