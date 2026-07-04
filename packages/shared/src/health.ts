export interface GatewayHealthResponse {
	ok: boolean;
	service: 'newsroom-harness';
	version: string;
	time: string;
	uptimeSeconds?: number;
	db: {
		ok: boolean;
		path: string;
		backend?: 'sqlite' | 'sqlite+postgres' | 'sqlite+supabase' | 'stateless';
		error?: string;
	};
	openai: {
		configured: boolean;
	};
	modelProvider?: {
		name: 'openai' | 'perplexity';
		configured: boolean;
	};
	config?: {
		ok: boolean;
		errors: string[];
		warnings: string[];
	};
	scheduler?: {
		enabled?: boolean;
		running: boolean;
		intervalMs: number;
		dueJobs: number | null;
		activeRuns: number | null;
	};
	capabilities?: {
		chat: boolean;
		responses: boolean;
		jobs: boolean;
		runs: boolean;
		reports: boolean;
		memory: boolean;
		savedResearch: boolean;
		scheduler: boolean;
		persistence: 'sqlite' | 'sqlite+postgres' | 'sqlite+supabase' | 'stateless';
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
