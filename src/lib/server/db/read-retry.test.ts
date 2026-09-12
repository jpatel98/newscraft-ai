import { describe, expect, it, vi } from 'vitest';
import { retryRead } from './read-retry';

describe('disconnected SELECT recovery', () => {
	it('retries a wrapped transport failure once', async () => {
		const read = vi.fn().mockRejectedValueOnce({ cause: { code: 'CONNECTION_CLOSED' } }).mockResolvedValueOnce(['ok']);
		expect(await retryRead(read)).toEqual(['ok']);
		expect(read).toHaveBeenCalledTimes(2);
	});
	it('stops after the second disconnect', async () => {
		const failure = { code: 'ECONNRESET' };
		const read = vi.fn().mockRejectedValue(failure);
		await expect(retryRead(read)).rejects.toBe(failure);
		expect(read).toHaveBeenCalledTimes(2);
	});
	it.each(['23505', '42501', '57014', 'ETIMEDOUT', 'ENOTFOUND', 'CERT_HAS_EXPIRED', '28P01'])('does not retry %s', async code => {
		const failure = { code };
		const read = vi.fn().mockRejectedValue(failure);
		await expect(retryRead(read)).rejects.toBe(failure);
		expect(read).toHaveBeenCalledTimes(1);
	});
});
