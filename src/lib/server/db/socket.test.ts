import { EventEmitter } from 'node:events';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
	FALLBACK_DNS_SERVERS,
	FALLBACK_DNS_TIMEOUT_MS,
	PREFERRED_ADDRESS_TTL_MS,
	createDatabaseSocketFactory,
	connectWithTimeout,
	parseDatabaseUrl
} from './socket';

function codedError(code: string): Error & { code: string } {
	return Object.assign(new Error(code), { code });
}

function fakeSocket(): net.Socket {
	return {} as net.Socket;
}

function fakeSocketWithRemoteAddress(remoteAddress: string): net.Socket {
	return { remoteAddress } as net.Socket;
}

describe('database socket fallback', () => {
	it('preserves the database hostname for strict TLS SNI after an A-record fallback', async () => {
		const connectCalls: Array<{ host: string; port: number; timeoutMs: number }> = [];
		const connect = vi.fn(async (host: string, port: number, timeoutMs: number) => {
			connectCalls.push({ host, port, timeoutMs });
			if (connectCalls.length === 1) throw codedError('ENOTFOUND');
			return fakeSocket();
		});
		const resolve4 = vi.fn(async () => ['185.40.234.55', '185.40.234.75', '185.40.234.55']);
		const factory = createDatabaseSocketFactory(
			{ hostname: 'contabo.example.ts.net', port: 10000 },
			{ connect, resolve4, timeoutMs: 10_000, now: () => 0 }
		);

		const socket = await factory({ connect_timeout: 30 });

		expect(connectCalls).toEqual([
			{ host: 'contabo.example.ts.net', port: 10000, timeoutMs: 3_333 },
			{ host: '185.40.234.55', port: 10000, timeoutMs: 3_333 }
		]);
		expect(resolve4).toHaveBeenCalledWith('contabo.example.ts.net');
		expect(socket.host).toBe('contabo.example.ts.net');
		expect(socket.port).toBe(10000);
	});

	it('uses an isolated resolver only after the default resolver also reports a DNS error', async () => {
		const resolver = {
			resolve4: vi.fn(async () => ['203.0.113.9']),
			setServers: vi.fn(),
			cancel: vi.fn()
		};
		const createResolver = vi.fn(() => resolver);
		const connect = vi.fn(async (host: string) => {
			if (host === 'db.example.test') throw codedError('ENOTFOUND');
			return fakeSocket();
		});
		const resolve4 = vi.fn(async () => {
			throw codedError('EAI_AGAIN');
		});

		const socket = await createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4, createResolver }
		)();

		expect(createResolver).toHaveBeenCalledTimes(1);
		expect(resolver.setServers).toHaveBeenCalledWith([...FALLBACK_DNS_SERVERS]);
		expect(resolver.resolve4).toHaveBeenCalledWith('db.example.test');
		expect(socket.host).toBe('db.example.test');
	});

	it.each(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'])(
		'retries a host after a retryable TCP connection error (%s)',
		async (code) => {
			const resolve4 = vi.fn(async () => ['203.0.113.10']);
			const connect = vi.fn(async (host: string) => {
				if (host === 'db.example.test') throw codedError(code);
				return fakeSocket();
			});
			const factory = createDatabaseSocketFactory(
				{ hostname: 'db.example.test', port: 5432 },
				{ connect, resolve4, now: () => 0 }
			);

			const socket = await factory();
			expect(socket.host).toBe('db.example.test');
			expect(connect).toHaveBeenCalledTimes(2);
			expect(resolve4).toHaveBeenCalledWith('db.example.test');
		}
	);

	it('does not retry or resolve a host after a non-retryable connection error', async () => {
		const resolve4 = vi.fn();
		const connect = vi.fn(async () => {
			throw codedError('EPROTO');
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4 }
		);

		await expect(factory()).rejects.toMatchObject({ code: 'EPROTO' });
		expect(connect).toHaveBeenCalledTimes(1);
		expect(resolve4).not.toHaveBeenCalled();
	});

	it('fails over to a fresh A-record candidate within one bounded connection budget', async () => {
		let nowMs = 0;
		const connectCalls: Array<{ host: string; timeoutMs: number }> = [];
		const connect = vi.fn(async (host: string, _port: number, timeoutMs: number) => {
			connectCalls.push({ host, timeoutMs });
			nowMs += timeoutMs;
			if (host === 'db.example.test' || host === '185.40.234.55') throw codedError('ETIMEDOUT');
			return fakeSocket();
		});
		const resolve4 = vi.fn(async () => ['185.40.234.55', '185.40.234.75', '185.40.234.198']);
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4, timeoutMs: 10_000, now: () => nowMs }
		);

		const socket = await factory();

		expect(connectCalls.map(({ host }) => host)).toEqual([
			'db.example.test',
			'185.40.234.55',
			'185.40.234.75'
		]);
		expect(connectCalls.reduce((total, call) => total + call.timeoutMs, 0)).toBeLessThanOrEqual(10_000);
		expect(connectCalls.every(({ timeoutMs }) => timeoutMs > 0)).toBe(true);
		expect(socket.host).toBe('db.example.test');
		expect(socket.port).toBe(5432);
	});

	it('stops after the shared timeout budget instead of retrying indefinitely', async () => {
		let nowMs = 0;
		const connectCalls: Array<{ host: string; timeoutMs: number }> = [];
		const connect = vi.fn(async (host: string, _port: number, timeoutMs: number) => {
			connectCalls.push({ host, timeoutMs });
			nowMs += timeoutMs;
			throw codedError('ETIMEDOUT');
		});
		const resolve4 = vi.fn(async () => ['203.0.113.10', '203.0.113.11']);
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4, timeoutMs: 10_000, now: () => nowMs }
		);

		await expect(factory()).rejects.toMatchObject({ code: 'ETIMEDOUT' });
		expect(connectCalls).toHaveLength(3);
		expect(connectCalls.reduce((total, call) => total + call.timeoutMs, 0)).toBe(10_000);
		expect(nowMs).toBe(10_000);
	});

	it('does not retry another address after a candidate TLS or protocol error', async () => {
		const connectCalls: string[] = [];
		const connect = vi.fn(async (host: string) => {
			connectCalls.push(host);
			if (host === 'db.example.test') throw codedError('ECONNREFUSED');
			throw codedError('EPROTO');
		});
		const resolve4 = vi.fn(async () => ['203.0.113.10', '203.0.113.11']);
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4, now: () => 0 }
		);

		await expect(factory()).rejects.toMatchObject({ code: 'EPROTO' });
		expect(connectCalls).toEqual(['db.example.test', '203.0.113.10']);
	});

	it('reuses a successful IPv4 address without extending its fixed expiry', async () => {
		let nowMs = 0;
		const connectCalls: string[] = [];
		const connect = vi.fn(async (host: string) => {
			connectCalls.push(host);
			return fakeSocketWithRemoteAddress('203.0.113.55');
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4: vi.fn(), now: () => nowMs }
		);

		await factory();
		nowMs = PREFERRED_ADDRESS_TTL_MS - 1;
		await factory();
		nowMs = PREFERRED_ADDRESS_TTL_MS + 1;
		await factory();

		expect(connectCalls).toEqual([
			'db.example.test',
			'203.0.113.55',
			'db.example.test'
		]);
	});

	it('invalidates a cached TCP address and falls through to fresh DNS candidates', async () => {
		const connectCalls: string[] = [];
		const resolve4 = vi.fn(async () => ['203.0.113.75']);
		const connect = vi.fn(async (host: string) => {
			connectCalls.push(host);
			if (host === 'db.example.test') {
				if (connectCalls.length === 1) return fakeSocketWithRemoteAddress('203.0.113.55');
				throw codedError('ECONNREFUSED');
			}
			if (host === '203.0.113.55') throw codedError('ETIMEDOUT');
			return fakeSocketWithRemoteAddress('203.0.113.75');
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4, now: () => 0 }
		);

		await factory();
		await factory();

		expect(connectCalls).toEqual([
			'db.example.test',
			'203.0.113.55',
			'db.example.test',
			'203.0.113.75'
		]);
		expect(resolve4).toHaveBeenCalledTimes(1);
	});

	it('does not retry DNS after a cached non-retryable connection error', async () => {
		const connectCalls: string[] = [];
		const resolve4 = vi.fn();
		const connect = vi.fn(async (host: string) => {
			connectCalls.push(host);
			if (host === 'db.example.test') return fakeSocketWithRemoteAddress('203.0.113.55');
			throw codedError('EPROTO');
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4, now: () => 0 }
		);

		await factory();
		await expect(factory()).rejects.toMatchObject({ code: 'EPROTO' });
		expect(connectCalls).toEqual(['db.example.test', '203.0.113.55']);
		expect(resolve4).not.toHaveBeenCalled();
	});

	it('destroys a socket when the factory-owned TCP timeout fires', async () => {
		const socket = new EventEmitter() as net.Socket & {
			timeoutCallback?: () => void;
			destroyedByTest?: boolean;
		};
		socket.setTimeout = ((_milliseconds: number, callback?: () => void) => {
			socket.timeoutCallback = callback;
			return socket;
		}) as net.Socket['setTimeout'];
		socket.destroy = (() => {
			socket.destroyedByTest = true;
			socket.emit('close');
			return socket;
		}) as net.Socket['destroy'];

		const promise = connectWithTimeout('db.example.test', 5432, 17, () => socket);
		socket.timeoutCallback?.();

		await expect(promise).rejects.toMatchObject({ code: 'ETIMEDOUT' });
		expect(socket.destroyedByTest).toBe(true);
	});

	it('marks verify-full and direct TLS database URLs as strict endpoints without exposing credentials', () => {
		expect(parseDatabaseUrl('postgresql://user:secret@db.example.test:10000/news?sslmode=verify-full')).toEqual({
			hostname: 'db.example.test',
			port: 10000,
			strictTls: true,
			directTls: false
		});
		expect(parseDatabaseUrl('postgresql://user:secret@127.0.0.1/news?sslmode=disable')).toEqual({
			hostname: '127.0.0.1',
			port: 5432,
			strictTls: false,
			directTls: false
		});
		expect(parseDatabaseUrl('postgresql://user:secret@db.example.test/news?sslmode=verify-full&sslnegotiation=direct')).toMatchObject({
			strictTls: true,
			directTls: true
		});
		expect(FALLBACK_DNS_TIMEOUT_MS).toBe(1_500);
	});
});
