declare global {
	namespace App {
		interface Locals {
			user: { id: string; email: string; name: string } | null;
		}
		interface PageData {
			user: { id: string; email: string; name: string } | null;
		}
	}
}

export {};
