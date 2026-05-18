export interface GatewayHealthResponse {
	ok: boolean;
	service: 'newsroom-harness';
	version: string;
	time: string;
	db: {
		ok: boolean;
		path: string;
	};
	openai: {
		configured: boolean;
	};
}
