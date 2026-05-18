import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw.trim()) return {} as T;
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new HttpError(400, 'invalid json');
	}
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store'
	});
	res.end(JSON.stringify(body));
}

export function writeText(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, {
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store'
	});
	res.end(body);
}

export function bearerToken(req: IncomingMessage): string {
	const header = req.headers.authorization || '';
	if (Array.isArray(header)) return '';
	return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

export function tokenMatches(actual: string, expected: string): boolean {
	if (!expected) return true;
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function noStoreSseHeaders(): Record<string, string> {
	return {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-cache, no-transform',
		connection: 'keep-alive',
		'x-accel-buffering': 'no'
	};
}
