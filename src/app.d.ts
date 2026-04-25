declare global {
	namespace App {
		interface Locals {
			user: { authed: true } | null;
		}
		interface PageData {
			user: { authed: true } | null;
		}
	}
}

export {};
