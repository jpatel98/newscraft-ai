declare global {
	namespace App {
		interface Locals {
			user: { id: string; email: string; name: string; role: 'admin' | 'member' } | null;
			traceId: string;
		}
		interface PageData {
			user: { id: string; email: string; name: string; role: 'admin' | 'member' } | null;
		}
	}
}

export {};
