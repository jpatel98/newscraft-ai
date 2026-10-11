/**
 * Current date and time in the newsroom's timezone, e.g.
 * "Friday, October 10, 2026, 11:05 p.m. ET". The research worker uses this to
 * resolve relative dates ("today", "tonight", "past 24 hours").
 */
export function formatNewsroomToday(timezone: string, now: Date = new Date()): string {
	try {
		return formatIn(timezone, now);
	} catch {
		return formatIn('America/Toronto', now);
	}
}

function formatIn(timeZone: string, now: Date): string {
	const date = new Intl.DateTimeFormat('en-US', {
		timeZone,
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	}).format(now);
	const time = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
		timeZoneName: 'short'
	}).formatToParts(now);
	const part = (type: string) => time.find((entry) => entry.type === type)?.value ?? '';
	const meridiem = part('dayPeriod').replace(/\./g, '').toLowerCase() === 'pm' ? 'p.m.' : 'a.m.';
	const zone = part('timeZoneName').replace(/^([ECMPAH])[SD]T$/, '$1T');
	return `${date}, ${part('hour')}:${part('minute')} ${meridiem}${zone ? ` ${zone}` : ''}`;
}
