import { env } from '$env/dynamic/private';
import type { CopyFormat, CopyLine, CopyRequestClaim } from '$lib/utils/ledger-copy';

const COPY_TIMEOUT_MS = 45_000;

/**
 * The worker's copy writer (POST /v1/ledger/copy): one tagged sentence per
 * line. Returns null when the worker cannot be reached or answers badly.
 */
export async function workerLedgerCopy(format: CopyFormat, title: string, claims: CopyRequestClaim[]): Promise<CopyLine[] | null> {
	const base = (env.NEWSCRAFT_AGENT_URL || '').trim().replace(/\/$/, '');
	const token = (env.NEWSCRAFT_AGENT_API_TOKEN || '').trim();
	if (!base || !token) return null;
	try {
		const response = await fetch(`${base}/v1/ledger/copy`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ format, title, claims }),
			signal: AbortSignal.timeout(COPY_TIMEOUT_MS)
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { lines?: unknown };
		if (!Array.isArray(body.lines)) return null;
		return body.lines.flatMap((item) => {
			const { claims: tags, text } = (item ?? {}) as { claims?: unknown; text?: unknown };
			if (typeof text !== 'string' || !text.trim()) return [];
			return [{ claims: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [], text: text.trim() }];
		});
	} catch {
		return null;
	}
}
