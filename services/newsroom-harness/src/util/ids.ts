import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
	return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function filenameTimestamp(date = new Date()): string {
	return date.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
}
