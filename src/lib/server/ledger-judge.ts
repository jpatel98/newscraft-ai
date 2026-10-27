import { env } from '$env/dynamic/private';
import type { ClaimJudge, JudgeVerdict } from '$lib/utils/claim-matcher';

const JUDGE_TIMEOUT_MS = 8000;
const VERDICTS: ReadonlySet<string> = new Set(['same', 'contradicts', 'different']);

/**
 * The worker's claim judge (POST /v1/ledger/judge). Returns null on any
 * failure: the matcher then merges only near-identical wordings.
 */
export const workerClaimJudge: ClaimJudge = async (pairs) => {
	const base = (env.NEWSCRAFT_AGENT_URL || '').trim().replace(/\/$/, '');
	const token = (env.NEWSCRAFT_AGENT_API_TOKEN || '').trim();
	if (!base || !token || !pairs.length) return null;
	try {
		const response = await fetch(`${base}/v1/ledger/judge`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ pairs }),
			signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS)
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { verdicts?: unknown };
		if (!Array.isArray(body.verdicts)) return null;
		const out = new Map<string, JudgeVerdict>();
		for (const item of body.verdicts) {
			const { id, verdict } = (item ?? {}) as { id?: unknown; verdict?: unknown };
			if (typeof id === 'string' && typeof verdict === 'string' && VERDICTS.has(verdict)) out.set(id, verdict as JudgeVerdict);
		}
		return out;
	} catch {
		return null;
	}
};
