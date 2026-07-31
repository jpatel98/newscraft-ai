const DEFAULT_NEWSROOM_TIME_ZONE = 'America/Toronto';

export interface NewsroomTimeContextOptions {
	now?: Date;
	timeZone?: string;
	request?: string;
}

export interface NewsroomTemporalContext {
	requestTimestamp: string;
	timeZone: string;
	localDate: string;
	windowStart: string;
	windowEnd: string;
	windowLabel: string;
	fallbackWindowStart: string;
	fallbackPolicy: 'prior_24_hours_if_sparse';
	backgroundPolicy: 'dated_and_labeled_only';
}

export type NewsroomClock = () => Date;

export function newsroomTimeZone(): string {
	return process.env.NEWSROOM_TIME_ZONE || DEFAULT_NEWSROOM_TIME_ZONE;
}

export function newsroomTimeContext(options: NewsroomTimeContextOptions = {}): string {
	return formatNewsroomTemporalContext(createNewsroomTemporalContext(options));
}

export function createNewsroomTemporalContext(
	options: NewsroomTimeContextOptions = {}
): NewsroomTemporalContext {
	const now = options.now ?? new Date();
	const timeZone = options.timeZone || newsroomTimeZone();
	const localDate = localDateFor(now, timeZone);
	const window = freshnessWindow(options.request || '', now, localDate, timeZone);
	return {
		requestTimestamp: now.toISOString(),
		timeZone,
		localDate,
		windowStart: window.start.toISOString(),
		windowEnd: window.end.toISOString(),
		windowLabel: window.label,
		fallbackWindowStart: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
		fallbackPolicy: 'prior_24_hours_if_sparse',
		backgroundPolicy: 'dated_and_labeled_only'
	};
}

function freshnessWindow(request: string, now: Date, localDate: string, timeZone: string) {
	const todayStart = zonedMidnight(localDate, timeZone);
	const explicitDays = request.match(/\b(?:past|last)\s+(\d{1,2})\s+days?\b/i);
	if (explicitDays) {
		const days = Math.max(1, Math.min(31, Number(explicitDays[1])));
		return {
			start: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
			end: now,
			label: `the last ${days} days through ${localDate} (${timeZone})`
		};
	}
	if (/\b(?:this|past) week\b|\blast seven days\b/i.test(request)) {
		return {
			start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
			end: now,
			label: `the last 7 days through ${localDate} (${timeZone})`
		};
	}
	if (/\byesterday\b/i.test(request) && !/\btoday\b/i.test(request)) {
		const start = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
		return { start, end: todayStart, label: `yesterday in ${timeZone}` };
	}
	return { start: todayStart, end: now, label: `today so far (${localDate}, ${timeZone})` };
}

export function formatNewsroomTemporalContext(context: NewsroomTemporalContext): string {
	const now = new Date(context.requestTimestamp);
	const timeZone = context.timeZone;
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short'
	}).formatToParts(now);
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	const localTime = [
		`${value('weekday')}, ${value('month')} ${value('day')}, ${value('year')}`,
		`at ${value('hour')}:${value('minute')} ${value('dayPeriod')} ${value('timeZoneName')}`.replace(/\s+/g, ' ').trim()
	]
		.filter(Boolean)
		.join(' ');

	return [
		'Authoritative request-scoped temporal contract:',
		`Current local newsroom time: ${localTime}.`,
		`Newsroom timezone: ${timeZone}.`,
		`Local newsroom date: ${context.localDate}.`,
		`Requested freshness window: ${context.windowStart} through ${context.windowEnd} (${context.windowLabel}).`,
		`Fallback window starts ${context.fallbackWindowStart}; use it only when today is sparse and label fallback items explicitly.`,
		'Older or unknown-date evidence is background only and must be explicitly labeled.',
		'Interpret relative date phrases such as "today", "tonight", "tomorrow", and "yesterday" using this local newsroom date unless the user explicitly specifies another timezone.'
	].join('\n');
}

function localDateFor(date: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(date);
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${value('year')}-${value('month')}-${value('day')}`;
}

function zonedMidnight(localDate: string, timeZone: string): Date {
	const [year, month, day] = localDate.split('-').map(Number);
	let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric', month: '2-digit', day: '2-digit',
			hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
		}).formatToParts(new Date(guess));
		const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value || 0);
		const represented = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
		guess += Date.UTC(year, month - 1, day, 0, 0, 0) - represented;
	}
	return new Date(guess);
}

export function isCurrentEventQuery(query: string): boolean {
	const text = query.replace(/https?:\/\/\S+/gi, ' ');
	return /\b(latest|current|today|tonight|tomorrow|yesterday|this week|breaking|schedule|fixtures)\b/i.test(
		text
	);
}

export function currentAsOfLabel(options: NewsroomTimeContextOptions = {}): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: options.timeZone || newsroomTimeZone(),
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short'
	}).format(options.now ?? new Date());
}
