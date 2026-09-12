const DISCONNECTED = new Set(['CONNECTION_CLOSED', 'CONNECTION_DESTROYED', 'ECONNRESET', 'EPIPE']);

function disconnected(error: unknown): boolean {
	const seen = new Set<unknown>();
	for (let current = error; current && typeof current === 'object' && !seen.has(current);) {
		seen.add(current);
		const cause = current as { code?: string; cause?: unknown };
		if (cause.code && DISCONNECTED.has(cause.code)) return true;
		current = cause.cause;
	}
	return false;
}

/** Only for side-effect-free SELECTs. Never wrap transactions, writes or locks. */
export async function retryRead<T>(read: () => PromiseLike<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (!disconnected(error)) throw error;
		// postgres.js removes the broken connection before rejecting its query.
		// One fresh attempt only; SQL, TLS, auth and timeout errors propagate.
		return await read();
	}
}
