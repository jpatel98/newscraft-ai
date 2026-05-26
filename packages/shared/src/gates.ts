import type { NewsroomEventDto, NewsroomEventJson } from './jobs.js';

export type NewsroomGateType =
	| 'pitch'
	| 'verification'
	| 'draft_review'
	| 'legal_style'
	| 'publish'
	| 'crawl_plan'
	| 'source_health'
	| 'budget';

export type NewsroomGateStatus = 'open' | 'resolved';

export interface NewsroomGateResolutionDto {
	action: string;
	notes: string | null;
	payload: NewsroomEventJson | null;
	actor: string;
	resolved_at: string;
	event_id: string | null;
}

export interface NewsroomGateDto {
	id: string;
	workspace_id: string;
	story_id: string | null;
	job_id: string | null;
	run_id: string | null;
	type: NewsroomGateType;
	title: string;
	summary: string;
	status: NewsroomGateStatus;
	priority: number;
	payload: NewsroomEventJson;
	actions: string[];
	created_by: string;
	created_at: string;
	resolution: NewsroomGateResolutionDto | null;
}

export interface QueueGateInput {
	workspace_id?: string;
	story_id?: string | null;
	job_id?: string | null;
	run_id?: string | null;
	type: NewsroomGateType;
	title: string;
	summary: string;
	priority?: number;
	payload?: unknown;
	actions?: string[];
	created_by?: string;
	created_at?: string;
}

export interface ResolveGateInput {
	action: string;
	notes?: string | null;
	payload?: unknown;
	actor?: string;
	resolved_at?: string;
}

export interface ResolveGateResult {
	gate: NewsroomGateDto;
	event: NewsroomEventDto;
}
