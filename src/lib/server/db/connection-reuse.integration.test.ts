import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from './index';
import { retryRead } from './read-retry';

const url = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe.skipIf(!url)('application database pool lifecycle', () => {
	afterAll(async () => { await sql.end({ timeout: 1 }); });
	it('reuses after six seconds, recovers a disconnected socket, then reaps idle sockets', async () => {
		const [first] = await sql`SELECT pg_backend_pid() AS pid`;
		await pause(6_000);
		const [reused] = await sql`SELECT pg_backend_pid() AS pid`;
		expect(reused.pid).toBe(first.pid);
		const admin = postgres(url, { max: 1 });
		try { await admin`SELECT pg_terminate_backend(${first.pid})`; }
		finally { await admin.end({ timeout: 1 }); }
		await pause(100);
		const [reconnected] = await retryRead(() => sql`SELECT pg_backend_pid() AS pid`);
		expect(reconnected.pid).not.toBe(first.pid);
		await pause(16_000);
		const [reaped] = await sql`SELECT pg_backend_pid() AS pid`;
		expect(reaped.pid).not.toBe(reconnected.pid);
	}, 30_000);
});
