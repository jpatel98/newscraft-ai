declare global {
	namespace App {
		interface Locals {
			user: { id: string; email: string; name: string; role: 'admin' | 'member' } | null;
		}
		interface PageData {
			user: { id: string; email: string; name: string; role: 'admin' | 'member' } | null;
		}
	}
}

export {};
