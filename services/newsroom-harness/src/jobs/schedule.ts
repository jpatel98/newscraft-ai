const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function computeNextRunAt(schedule: string, fromIso = new Date().toISOString()): string | null {
	const from = new Date(fromIso);
	const base = Number.isFinite(from.getTime()) ? from : new Date();
	const interval = parseIntervalMs(schedule);
	if (interval) return new Date(base.getTime() + interval).toISOString();
	const cron = nextFromSimpleCron(schedule, base);
	return cron?.toISOString() ?? new Date(base.getTime() + HOUR).toISOString();
}

export function parseIntervalMs(schedule: string): number | null {
	const raw = schedule.trim().toLowerCase();
	if (!raw) return null;
	if (raw === 'hourly') return HOUR;
	if (raw === 'daily') return DAY;
	const match = raw.match(/^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/);
	if (!match) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	const unit = match[2];
	if (unit.startsWith('s')) return amount * 1000;
	if (unit.startsWith('m')) return amount * MINUTE;
	if (unit.startsWith('h')) return amount * HOUR;
	return amount * DAY;
}

function nextFromSimpleCron(schedule: string, from: Date): Date | null {
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [minute, hour] = parts;
	const next = new Date(from.getTime());
	next.setSeconds(0, 0);
	next.setMinutes(next.getMinutes() + 1);

	for (let i = 0; i < 60 * 24 * 32; i += 1) {
		if (matchesCronPart(next.getMinutes(), minute, 0, 59) && matchesCronPart(next.getHours(), hour, 0, 23)) {
			return next;
		}
		next.setMinutes(next.getMinutes() + 1);
	}
	return null;
}

function matchesCronPart(value: number, part: string, min: number, max: number): boolean {
	if (part === '*') return true;
	const every = part.match(/^\*\/(\d+)$/);
	if (every) {
		const step = Number(every[1]);
		return Number.isFinite(step) && step > 0 && value % step === 0;
	}
	const exact = Number(part);
	return Number.isInteger(exact) && exact >= min && exact <= max && value === exact;
}
