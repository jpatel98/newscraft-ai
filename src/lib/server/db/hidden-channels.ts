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

export async function listHiddenChannelJobIds(accountId: string): Promise<string[]> {
	const raw = (await getSetting(key(accountId))) ?? (await getSetting(KEY));
	if (!raw) return [];
	try {
		return normalize(JSON.parse(raw));
	} catch {
		return [];
	}
}

async function writeHiddenChannelJobIds(accountId: string, ids: string[]): Promise<void> {
	await setSetting(key(accountId), JSON.stringify(normalize(ids)));
}

export async function hideChannelJobId(accountId: string, jobId: string): Promise<void> {
	const id = jobId.trim();
	if (!JOB_ID_RE.test(id)) return;
	const ids = new Set(await listHiddenChannelJobIds(accountId));
	ids.add(id);
	await writeHiddenChannelJobIds(accountId, Array.from(ids));
}

export async function unhideChannelJobId(accountId: string, jobId: string): Promise<void> {
	const id = jobId.trim();
	if (!JOB_ID_RE.test(id)) return;
	const ids = new Set(await listHiddenChannelJobIds(accountId));
	if (!ids.delete(id)) return;
	await writeHiddenChannelJobIds(accountId, Array.from(ids));
}
