export type JobStatus = 'scheduled' | 'paused' | 'queued' | 'running' | 'completed' | 'failed';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface NewsroomJobDto {
	id: string;
	name: string;
	title: string;
	description?: string;
	prompt: string | null;
	schedule: string;
	cron: string;
	schedule_display: string;
	enabled: boolean;
	state: JobStatus | string;
	next_run_at: string | null;
	last_run_at: string | null;
	last_status: string | null;
	last_error: string | null;
	last_delivery_error?: string | null;
	deliver: string | null;
	output_format: string;
	created_at: string;
	updated_at: string;
}

export interface NewsroomRunDto {
	id: string;
	job_id: string;
	job_name?: string | null;
	status: RunStatus;
	queued_at: string | null;
	started_at: string | null;
	completed_at: string | null;
	updated_at: string | null;
	elapsed_ms: number | null;
	last_error: string | null;
	trigger: 'manual' | 'schedule' | 'test' | string;
	steps?: NewsroomRunStepDto[];
	tool_calls?: NewsroomToolCallDto[];
	source_count?: number;
	latest_activity_at?: string | null;
}

export interface NewsroomRunStepDto {
	id: number | string;
	run_id: string;
	step_type: string;
	label: string;
	status: string;
	started_at: string;
	completed_at: string | null;
}

export interface NewsroomToolCallDto {
	id: string;
	run_id: string | null;
	name: string;
	status: string;
	started_at: string;
	completed_at: string | null;
	error: string | null;
}

export interface NewsroomSourceDto {
	id: string;
	run_id: string;
	job_id: string | null;
	url: string;
	title: string;
	fetched_at: string;
	snippet: string;
	summary: string;
	used: boolean;
}

export interface NewsroomReportDto {
	id: string;
	run_id: string;
	job_id: string;
	title: string;
	markdown: string;
	created_at: string;
	ingest_status: 'not_configured' | 'sent' | 'failed';
	ingest_error: string | null;
}

export interface CreateJobInput {
	name?: string;
	title?: string;
	prompt?: string;
	schedule?: string;
	cron?: string;
	enabled?: boolean;
	deliver?: string | null;
	output_format?: string;
	outputFormat?: string;
	description?: string;
}

export interface UpdateJobInput extends Partial<CreateJobInput> {}
