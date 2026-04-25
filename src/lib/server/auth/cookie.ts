import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

const COOKIE = 'hermes_sess';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

interface Payload {
	v: 1;
	iat: number;
	jti: string;
}

function secret(): Buffer {
	const s = env.APP_SESSION_SECRET;
	if (!s) throw new Error('APP_SESSION_SECRET not configured');
	return Buffer.from(s, 'base64');
}

function b64u(buf: Buffer): string {
	return buf.toString('base64url');
}

export function mintSessionCookie(): { name: string; value: string; opts: CookieOpts } {
	const payload: Payload = { v: 1, iat: Math.floor(Date.now() / 1000), jti: b64u(randomBytes(12)) };
	const data = b64u(Buffer.from(JSON.stringify(payload)));
	const sig = b64u(createHmac('sha256', secret()).update(data).digest());
	return {
		name: COOKIE,
		value: `${data}.${sig}`,
		opts: {
			httpOnly: true,
			sameSite: 'lax',
			secure: env.NODE_ENV === 'production',
			path: '/',
			maxAge: MAX_AGE
		}
	};
}

export function verifySessionCookie(value: string | undefined): boolean {
	if (!value) return false;
	const idx = value.lastIndexOf('.');
	if (idx < 0) return false;
	const data = value.slice(0, idx);
	const sig = value.slice(idx + 1);
	const expected = createHmac('sha256', secret()).update(data).digest();
	let provided: Buffer;
	try {
		provided = Buffer.from(sig, 'base64url');
	} catch {
		return false;
	}
	if (provided.length !== expected.length) return false;
	if (!timingSafeEqual(provided, expected)) return false;
	try {
		const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Payload;
		const ageSec = Math.floor(Date.now() / 1000) - payload.iat;
		if (ageSec > MAX_AGE) return false;
		if (payload.v !== 1) return false;
		return true;
	} catch {
		return false;
	}
}

export const SESSION_COOKIE_NAME = COOKIE;

export interface CookieOpts {
	httpOnly: true;
	sameSite: 'lax';
	secure: boolean;
	path: '/';
	maxAge: number;
}
