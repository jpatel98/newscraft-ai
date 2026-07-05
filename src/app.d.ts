declare global {
	namespace App {
		interface Locals {
			user: { id: string; email: string; name: string; role: 'admin' | 'member' } | null;
			traceId: string;
			isMarketingHost: boolean;
		}
		interface PageData {
			user: { id: string; email: string; name: string; role: 'admin' | 'member' } | null;
			isMarketingHost: boolean;
		}
	}
}

export {};
