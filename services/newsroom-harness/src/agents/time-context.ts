const DEFAULT_NEWSROOM_TIME_ZONE = 'America/Toronto';

export interface NewsroomTimeContextOptions {
	now?: Date;
	timeZone?: string;
}

export function newsroomTimeZone(): string {
	return process.env.NEWSROOM_TIME_ZONE || DEFAULT_NEWSROOM_TIME_ZONE;
}

export function newsroomTimeContext(options: NewsroomTimeContextOptions = {}): string {
	const now = options.now ?? new Date();
	const timeZone = options.timeZone || newsroomTimeZone();
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
		`Current local newsroom time: ${localTime}.`,
		`Newsroom timezone: ${timeZone}.`,
		'Interpret relative date phrases such as "today", "tonight", "tomorrow", and "yesterday" using this local newsroom date unless the user explicitly specifies another timezone.'
	].join('\n');
}

export function isCurrentEventQuery(query: string): boolean {
	return /\b(latest|current|today|tonight|tomorrow|yesterday|this week|breaking|schedule|fixtures?|verify|confirm)\b/i.test(
		query
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
