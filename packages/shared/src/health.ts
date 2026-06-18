export interface GatewayHealthResponse {
	ok: boolean;
	service: 'newsroom-harness';
	version: string;
	time: string;
	uptimeSeconds?: number;
	db: {
		ok: boolean;
		path: string;
		backend?: 'sqlite' | 'sqlite+supabase';
		error?: string;
	};
	openai: {
		configured: boolean;
	};
	modelProvider?: {
		name: 'openai' | 'perplexity';
		configured: boolean;
	};
	scheduler?: {
		enabled?: boolean;
		running: boolean;
		intervalMs: number;
		dueJobs: number | null;
		activeRuns: number | null;
	};
	ingest?: {
		configured: boolean;
		urlConfigured: boolean;
		keyConfigured: boolean;
	};
	limits?: {
		runTimeoutMs: number;
		maxToolCalls: number;
		retryLimit: number;
	};
}
