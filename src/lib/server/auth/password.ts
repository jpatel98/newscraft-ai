import { hash, verify } from '@node-rs/argon2';
import { env } from '$env/dynamic/private';
import { getSetting } from '$lib/server/db';

const ARGON2ID = 2 as const; // @node-rs/argon2 Algorithm.Argon2id; const enum can't be imported under verbatimModuleSyntax
const PARAMS = {
	algorithm: ARGON2ID,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

const HASH_KEY = 'auth.password_hash';

async function legacyStoredHash(): Promise<string | undefined> {
	return (await getSetting(HASH_KEY)) ?? env.APP_PASSWORD_HASH;
}

export async function legacyPasswordConfigured(): Promise<boolean> {
	return Boolean(await legacyStoredHash());
}

export async function verifyHash(stored: string, plain: string): Promise<boolean> {
	if (!stored) return false;
	if (!plain) return false;
	try {
		return await verify(stored, plain);
	} catch {
		return false;
	}
}

export async function verifyLegacyPassword(plain: string): Promise<boolean> {
	const stored = await legacyStoredHash();
	if (!stored) return false;
	return verifyHash(stored, plain);
}

export async function hashPassword(plain: string): Promise<string> {
	return hash(plain, PARAMS);
}

// In-memory brute-force defense (single-process, single-VPS; resets on restart).
const MAX_FAILS = 5;
const LOCKOUT_MS = 30_000;
const fails = new Map<string, { count: number; lockedUntil: number }>();

export function lockedOut(key: string): number {
	const e = fails.get(key);
	if (!e) return 0;
	const remaining = e.lockedUntil - Date.now();
	return remaining > 0 ? remaining : 0;
}

export function recordFailure(key: string) {
	const e = fails.get(key) ?? { count: 0, lockedUntil: 0 };
	e.count += 1;
	if (e.count >= MAX_FAILS) {
		e.lockedUntil = Date.now() + LOCKOUT_MS;
		e.count = 0;
	}
	fails.set(key, e);
}

export function recordSuccess(key: string) {
	fails.delete(key);
}
