import { getSetting, setSetting } from './index';

const KEY = 'hermes.hidden_channel_job_ids';
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function normalize(ids: unknown): string[] {
	if (!Array.isArray(ids)) return [];
	const out = new Set<string>();
	for (const value of ids) {
		if (typeof value !== 'string') continue;
		const id = value.trim();
		if (!JOB_ID_RE.test(id)) continue;
		out.add(id);
	}
	return Array.from(out).sort();
}

function key(accountId: string): string {
	return `${KEY}.${accountId}`;
}

export function listHiddenChannelJobIds(accountId: string): string[] {
	const raw = getSetting(key(accountId)) ?? getSetting(KEY);
	if (!raw) return [];
	try {
		return normalize(JSON.parse(raw));
	} catch {
		return [];
	}
}

function writeHiddenChannelJobIds(accountId: string, ids: string[]): void {
	setSetting(key(accountId), JSON.stringify(normalize(ids)));
}

export function hideChannelJobId(accountId: string, jobId: string): void {
	const id = jobId.trim();
	if (!JOB_ID_RE.test(id)) return;
	const ids = new Set(listHiddenChannelJobIds(accountId));
	ids.add(id);
	writeHiddenChannelJobIds(accountId, Array.from(ids));
}

export function unhideChannelJobId(accountId: string, jobId: string): void {
	const id = jobId.trim();
	if (!JOB_ID_RE.test(id)) return;
	const ids = new Set(listHiddenChannelJobIds(accountId));
	if (!ids.delete(id)) return;
	writeHiddenChannelJobIds(accountId, Array.from(ids));
}
