import type { NewsroomEventDto } from './jobs.js';

export type NewsroomCrawlPlanArticleBodyStrategy = 'auto' | 'selector' | 'agent-extract';
export type NewsroomCrawlPlanChangeDetection = 'hash' | 'structured_diff' | 'semantic_similarity';

export interface NewsroomCrawlPlanCandidateLinkDto {
	title: string;
	url: string;
	reason: string;
	score: number;
}

export interface NewsroomCrawlPlanPoliteFetchOverridesDto {
	respect_robots: boolean;
	robots_override: boolean;
	host_delay_ms: number;
	failure_budget: number;
	archive_web: boolean;
}

export interface NewsroomCrawlPlanVersionDto {
	id: string;
	beat_id: string;
	version: number;
	seed_urls: string[];
	link_follow_rule: string;
	article_body_strategy: NewsroomCrawlPlanArticleBodyStrategy;
	polling_cadence: string;
	jitter_ms: number;
	change_detection: NewsroomCrawlPlanChangeDetection;
	polite_fetch: NewsroomCrawlPlanPoliteFetchOverridesDto;
	candidate_links: NewsroomCrawlPlanCandidateLinkDto[];
	created_by: string;
	created_at: string;
	source_memory_entry_id: string | null;
	supersedes_version: number | null;
}

export interface SaveCrawlPlanVersionInput {
	beat_id: string;
	id?: string;
	version?: number;
	seed_url?: string;
	seed_urls?: string[];
	link_follow_rule: string;
	article_body_strategy?: NewsroomCrawlPlanArticleBodyStrategy;
	polling_cadence?: string;
	jitter_ms?: number;
	change_detection?: NewsroomCrawlPlanChangeDetection;
	polite_fetch?: Partial<NewsroomCrawlPlanPoliteFetchOverridesDto>;
	candidate_links?: NewsroomCrawlPlanCandidateLinkDto[];
	created_by?: string;
	created_at?: string;
}

export interface ExecuteCrawlPlanInput {
	workspace_id?: string;
	job_id?: string | null;
	run_id?: string | null;
	version?: number;
	max_links?: number;
	actor?: string;
}

export interface CrawlPlanSourceEventDto {
	url: string;
	title: string;
	summary: string;
	event_id: string;
	content_hash: string | null;
	status_code: number | null;
	adapter: string;
	plan_version: number;
}

export interface ExecuteCrawlPlanResult {
	plan: NewsroomCrawlPlanVersionDto;
	events: NewsroomEventDto[];
	sources: CrawlPlanSourceEventDto[];
}
