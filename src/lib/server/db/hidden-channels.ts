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

export function listHiddenChannelJobIds(): string[] {
	const raw = getSetting(KEY);
	if (!raw) return [];
	try {
		return normalize(JSON.parse(raw));
	} catch {
		return [];
	}
}

function writeHiddenChannelJobIds(ids: string[]): void {
	setSetting(KEY, JSON.stringify(normalize(ids)));
}

export function hideChannelJobId(jobId: string): void {
	const id = jobId.trim();
	if (!JOB_ID_RE.test(id)) return;
	const ids = new Set(listHiddenChannelJobIds());
	ids.add(id);
	writeHiddenChannelJobIds(Array.from(ids));
}

export function unhideChannelJobId(jobId: string): void {
	const id = jobId.trim();
	if (!JOB_ID_RE.test(id)) return;
	const ids = new Set(listHiddenChannelJobIds());
	if (!ids.delete(id)) return;
	writeHiddenChannelJobIds(Array.from(ids));
}
