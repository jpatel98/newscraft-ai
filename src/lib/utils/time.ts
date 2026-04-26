const RELATIVE_UNITS = [
	{ limit: 60_000, size: 1, suffix: 'now' },
	{ limit: 3_600_000, size: 60_000, suffix: 'm' },
	{ limit: 86_400_000, size: 3_600_000, suffix: 'h' },
	{ limit: 604_800_000, size: 86_400_000, suffix: 'd' }
];

function validDate(ts: number): Date | null {
	const d = new Date(ts);
	return Number.isFinite(d.getTime()) ? d : null;
}

export function formatShortTime(ts: number): string {
	const d = validDate(ts);
	if (!d) return '';
	return new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit'
	}).format(d);
}

export function formatRelativeTime(ts: number, now = Date.now()): string {
	const d = validDate(ts);
	if (!d) return '';
	const diff = Math.max(0, now - d.getTime());
	for (const unit of RELATIVE_UNITS) {
		if (diff < unit.limit) {
			if (unit.suffix === 'now') return 'just now';
			return `${Math.max(1, Math.floor(diff / unit.size))}${unit.suffix}`;
		}
	}
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric'
	}).format(d);
}

export function formatThreadUpdated(ts: number): string {
	const d = validDate(ts);
	if (!d) return '';
	return `${formatRelativeTime(ts)} at ${formatShortTime(ts)}`;
}
