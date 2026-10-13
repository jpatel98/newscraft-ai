import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	FALLBACK_DNS_SERVERS,
	FALLBACK_DNS_TIMEOUT_MS,
	PREFERRED_ADDRESS_TTL_MS,
	TCP_CANDIDATE_STAGGER_MS,
	UNHEALTHY_ADDRESS_TTL_MS,
	createDatabaseSocketFactory,
	connectWithDirectTls,
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

function liveSocket(remoteAddress: string): net.Socket & EventEmitter & { bytesRead: number } {
	return Object.assign(new EventEmitter(), { remoteAddress, bytesRead: 0 }) as unknown as net.Socket &
		EventEmitter & { bytesRead: number };
}

function destroyableSocket(): net.Socket & { destroy: ReturnType<typeof vi.fn> } {
	const socket = { destroy: vi.fn() } as unknown as net.Socket & { destroy: ReturnType<typeof vi.fn> };
	return socket;
}

afterEach(() => {
	vi.useRealTimers();
});

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
			{ host: 'contabo.example.ts.net', port: 10000, timeoutMs: 1000 },
			{ host: '185.40.234.55', port: 10000, timeoutMs: 4_500 }
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
		const connectCalls: Array<{ host: string; timeoutMs: number }> = [];
		const connect = vi.fn(async (host: string, _port: number, timeoutMs: number) => {
			connectCalls.push({ host, timeoutMs });
			if (host === 'db.example.test' || host === '185.40.234.55') throw codedError('ETIMEDOUT');
			return fakeSocket();
		});
		const resolve4 = vi.fn(async () => ['185.40.234.55', '185.40.234.75', '185.40.234.198']);
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4, timeoutMs: 10_000, now: () => 0 }
		);

		const socket = await factory();

		expect(connectCalls.map(({ host }) => host)).toEqual([
			'db.example.test',
			'185.40.234.55',
			'185.40.234.75'
		]);
		expect(connectCalls.every(({ timeoutMs }) => timeoutMs > 0)).toBe(true);
		expect(connectCalls.every(({ timeoutMs }) => timeoutMs <= 10_000)).toBe(true);
		expect(socket.host).toBe('db.example.test');
		expect(socket.port).toBe(5432);
	});

	it('stops all candidates at the shared deadline instead of retrying indefinitely', async () => {
		vi.useFakeTimers();
		const connectCalls: Array<{ host: string; timeoutMs: number }> = [];
		const signals: AbortSignal[] = [];
		const connect = vi.fn(async (host: string, _port: number, timeoutMs: number, signal?: AbortSignal) => {
			connectCalls.push({ host, timeoutMs });
			if (signal) signals.push(signal);
			if (host === 'db.example.test') throw codedError('ETIMEDOUT');
			return new Promise<net.Socket>(() => undefined);
		});
		const resolve4 = vi.fn(async () => ['203.0.113.10', '203.0.113.11']);
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4, timeoutMs: 400 }
		);

		const result = factory();
		const rejection = expect(result).rejects.toMatchObject({ code: 'ETIMEDOUT' });
		await vi.advanceTimersByTimeAsync(400);
		await rejection;
		expect(connectCalls.map(({ host }) => host)).toEqual([
			'db.example.test',
			'203.0.113.10',
			'203.0.113.11'
		]);
		expect(signals.length).toBe(2);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		vi.useRealTimers();
	});

	it('starts a healthy candidate before a black-holed candidate times out', async () => {
		vi.useFakeTimers();
		let releaseBlackhole!: (socket: net.Socket) => void;
		const blackhole = new Promise<net.Socket>((resolve) => {
			releaseBlackhole = resolve;
		});
		const blackholeSocket = destroyableSocket();
		const connectCalls: string[] = [];
		const signals: AbortSignal[] = [];
		const connect = vi.fn(async (host: string, _port: number, _timeoutMs: number, signal?: AbortSignal) => {
			connectCalls.push(host);
			if (signal) signals.push(signal);
			if (host === 'db.example.test') throw codedError('ECONNREFUSED');
			if (host === '203.0.113.10') return blackhole;
			return fakeSocket();
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4: vi.fn(async () => ['203.0.113.10', '203.0.113.11']), timeoutMs: 1_000 }
		);

		const result = factory();
		await vi.advanceTimersByTimeAsync(TCP_CANDIDATE_STAGGER_MS);
		const socket = await result;

		expect(socket.host).toBe('db.example.test');
		expect(connectCalls).toEqual(['db.example.test', '203.0.113.10', '203.0.113.11']);
		expect(signals.length).toBe(2);
		expect(signals.filter((signal) => signal.aborted)).toHaveLength(1);
		releaseBlackhole(blackholeSocket);
		await vi.advanceTimersByTimeAsync(0);
		expect(blackholeSocket.destroy).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it('reserves a later candidate when two earlier TCP attempts stall', async () => {
		vi.useFakeTimers();
		const connectCalls: string[] = [];
		const signals: AbortSignal[] = [];
		const connect = vi.fn(async (host: string, _port: number, _timeoutMs: number, signal?: AbortSignal) => {
			connectCalls.push(host);
			if (signal) signals.push(signal);
			if (host === 'db.example.test') throw codedError('ECONNREFUSED');
			if (host === '203.0.113.12') return fakeSocket();
			return new Promise<net.Socket>(() => undefined);
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{
				connect,
				resolve4: vi.fn(async () => ['203.0.113.10', '203.0.113.11', '203.0.113.12']),
				timeoutMs: 1_000
			}
		);

		const result = factory();
		await vi.advanceTimersByTimeAsync(250);
		const socket = await result;

		expect(socket.host).toBe('db.example.test');
		expect(connectCalls).toEqual([
			'db.example.test',
			'203.0.113.10',
			'203.0.113.11',
			'203.0.113.12'
		]);
		expect(signals.filter((signal) => signal.aborted)).toHaveLength(2);
		vi.useRealTimers();
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

	it('keeps the cached-address probe separate from the short hostname probe', async () => {
		const attempts: Array<{ host: string; timeoutMs: number }> = [];
		const connect = vi.fn(async (host: string, _port: number, timeoutMs: number) => {
			attempts.push({ host, timeoutMs });
			return fakeSocketWithRemoteAddress('203.0.113.55');
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, now: () => 0, timeoutMs: 10_000 }
		);

		await factory();
		await factory();

		expect(attempts).toEqual([
			{ host: 'db.example.test', timeoutMs: 1_000 },
			{ host: '203.0.113.55', timeoutMs: 3_333 }
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

	it('aborts a socket when a competing candidate wins', async () => {
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
		const controller = new AbortController();
		const promise = connectWithTimeout('db.example.test', 5432, 17, () => socket, controller.signal);
		controller.abort();

		await expect(promise).rejects.toMatchObject({ code: 'ABORT_ERR', name: 'AbortError' });
		expect(socket.destroyedByTest).toBe(true);
	});

	it('skips an address whose peer reset the connection before replying', async () => {
		let nowMs = 0;
		const connectCalls: string[] = [];
		const sockets: Array<ReturnType<typeof liveSocket>> = [];
		const resolve4 = vi.fn(async () => ['185.40.234.55', '185.40.234.75', '185.40.234.198']);
		const connect = vi.fn(async (host: string) => {
			connectCalls.push(host);
			const socket = liveSocket(host === 'contabo.example.ts.net' ? '185.40.234.55' : host);
			sockets.push(socket);
			return socket;
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'contabo.example.ts.net', port: 10000 },
			{ connect, resolve4, now: () => nowMs }
		);

		await factory();
		// The TLS handshake on top of the raw socket is reset by the ingress node.
		sockets[0].emit('error', codedError('ECONNRESET'));
		sockets[0].emit('close');
		const retried = await factory();

		expect(connectCalls).toEqual(['contabo.example.ts.net', '185.40.234.75']);
		expect(retried.remoteAddress).toBe('185.40.234.75');
		expect(retried.host).toBe('contabo.example.ts.net');

		// The healthy sibling is now the cached preference.
		await factory();
		expect(connectCalls.at(-1)).toBe('185.40.234.75');

		// After the unhealthy window the hostname path is used again.
		nowMs = UNHEALTHY_ADDRESS_TTL_MS + 1;
		await factory();
		expect(connectCalls.at(-1)).toBe('contabo.example.ts.net');
	});

	it('also treats a clean close with no reply as unhealthy', async () => {
		const connectCalls: string[] = [];
		const sockets: Array<ReturnType<typeof liveSocket>> = [];
		const connect = vi.fn(async (host: string) => {
			connectCalls.push(host);
			const socket = liveSocket(host === 'db.example.test' ? '203.0.113.55' : host);
			sockets.push(socket);
			return socket;
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4: vi.fn(async () => ['203.0.113.55', '203.0.113.75']), now: () => 0 }
		);

		await factory();
		sockets[0].emit('end');
		await factory();

		expect(connectCalls).toEqual(['db.example.test', '203.0.113.75']);
	});

	it('keeps an address that served data before its connection closed', async () => {
		const connectCalls: string[] = [];
		const sockets: Array<ReturnType<typeof liveSocket>> = [];
		const resolve4 = vi.fn();
		const connect = vi.fn(async (host: string) => {
			connectCalls.push(host);
			const socket = liveSocket('203.0.113.55');
			sockets.push(socket);
			return socket;
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4, now: () => 0 }
		);

		await factory();
		// An idle pooled connection that already carried queries is closed.
		sockets[0].bytesRead = 4096;
		sockets[0].emit('error', codedError('ECONNRESET'));
		sockets[0].emit('close');
		await factory();

		expect(connectCalls).toEqual(['db.example.test', '203.0.113.55']);
		expect(resolve4).not.toHaveBeenCalled();
	});

	it('falls back to the hostname when every resolved address is unhealthy', async () => {
		const connectCalls: string[] = [];
		const sockets: Array<ReturnType<typeof liveSocket>> = [];
		const connect = vi.fn(async (host: string) => {
			connectCalls.push(host);
			const socket = liveSocket('203.0.113.55');
			sockets.push(socket);
			return socket;
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'db.example.test', port: 5432 },
			{ connect, resolve4: vi.fn(async () => ['203.0.113.55']), now: () => 0 }
		);

		await factory();
		sockets[0].emit('error', codedError('ECONNRESET'));
		await factory();

		expect(connectCalls).toEqual(['db.example.test', 'db.example.test']);
	});

	it('fails over within one attempt when an address drops the TLS handshake', async () => {
		const connectCalls: string[] = [];
		const resolve4 = vi.fn(async () => ['185.40.234.55', '185.40.234.75', '185.40.234.198']);
		const connect = vi.fn(async (host: string) => {
			connectCalls.push(host);
			if (host === 'contabo.example.ts.net' || host === '185.40.234.55') {
				throw Object.assign(codedError('ECONNRESET'), { address: '185.40.234.55' });
			}
			return fakeSocketWithRemoteAddress(host);
		});
		const factory = createDatabaseSocketFactory(
			{ hostname: 'contabo.example.ts.net', port: 10000 },
			{ connect, resolve4, now: () => 0 }
		);

		const socket = await factory();
		expect(socket.remoteAddress).toBe('185.40.234.75');
		expect(socket.host).toBe('contabo.example.ts.net');
		// The dropped node is skipped, not raced again.
		expect(connectCalls).toEqual(['contabo.example.ts.net', '185.40.234.75']);

		await factory();
		expect(connectCalls.at(-1)).toBe('185.40.234.75');
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

describe('direct TLS handshake in the socket hook', () => {
	async function listen(onSocket: (socket: net.Socket) => void): Promise<net.Server> {
		const server = net.createServer(onSocket);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		return server;
	}

	it('rejects a dropped handshake as a retryable reset carrying the address', async () => {
		const server = await listen((socket) => socket.once('data', () => socket.end()));
		const { port } = server.address() as net.AddressInfo;
		try {
			await expect(connectWithDirectTls('db.example.test', '127.0.0.1', port, 2_000)).rejects.toMatchObject({
				code: 'ECONNRESET',
				address: '127.0.0.1'
			});
		} finally {
			server.close();
		}
	});

	it('keeps certificate failures terminal', async (context) => {
		let key: Buffer;
		let cert: Buffer;
		try {
			const dir = mkdtempSync(path.join(tmpdir(), 'socket-tls-'));
			execFileSync('openssl', [
				'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
				'-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
				'-days', '1', '-subj', '/CN=db.example.test'
			], { stdio: 'ignore' });
			key = readFileSync(path.join(dir, 'key.pem'));
			cert = readFileSync(path.join(dir, 'cert.pem'));
		} catch {
			context.skip();
			return;
		}
		const server = tls.createServer({ key, cert, ALPNProtocols: ['postgresql'] }, (socket) => socket.end());
		server.on('tlsClientError', () => {});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as net.AddressInfo;
		try {
			const error = await connectWithDirectTls('db.example.test', '127.0.0.1', port, 2_000).then(
				() => null,
				(caught: Error & { code?: string }) => caught
			);
			expect(error?.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
		} finally {
			server.close();
		}
	});
});
