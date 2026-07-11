const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
	return value.length <= 254 && EMAIL_PATTERN.test(value);
}

export function normalizeDisplayName(value: string): string {
	return value.trim().replace(/\s+/g, ' ');
}
