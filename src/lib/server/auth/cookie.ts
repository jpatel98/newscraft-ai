import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

const COOKIE = 'agent_sess';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

interface Payload {
	v: 2;
	iat: number;
	jti: string;
	sub: string;
}

export interface SessionUser {
	accountId: string;
	issuedAt: number;
}

function secret(): Buffer {
	const s = env.APP_SESSION_SECRET;
	if (!s) throw new Error('APP_SESSION_SECRET not configured');
	const key = Buffer.from(s, 'base64');
	if (key.length < 32) throw new Error('APP_SESSION_SECRET must decode to at least 32 bytes');
	return key;
}

function b64u(buf: Buffer): string {
	return buf.toString('base64url');
}

export function mintSessionCookie(accountId: string): { name: string; value: string; opts: CookieOpts } {
	const payload: Payload = {
		v: 2,
		iat: Math.floor(Date.now() / 1000),
		jti: b64u(randomBytes(12)),
		sub: accountId
	};
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

export function verifySessionCookie(value: string | undefined): SessionUser | null {
	if (!value) return null;
	const idx = value.lastIndexOf('.');
	if (idx < 0) return null;
	const data = value.slice(0, idx);
	const sig = value.slice(idx + 1);
	const expected = createHmac('sha256', secret()).update(data).digest();
	let provided: Buffer;
	try {
		provided = Buffer.from(sig, 'base64url');
	} catch {
		return null;
	}
	if (provided.length !== expected.length) return null;
	if (!timingSafeEqual(provided, expected)) return null;
	try {
		const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Payload;
		const ageSec = Math.floor(Date.now() / 1000) - payload.iat;
		if (ageSec > MAX_AGE) return null;
		if (payload.v !== 2) return null;
		if (!payload.sub) return null;
		return { accountId: payload.sub, issuedAt: payload.iat };
	} catch {
		return null;
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
