export type RequestTimingName =
	| 'chat_snapshot' | 'auth' | 'sidebar' | 'ownership' | 'messages' | 'message_count'
	| 'active_run' | 'actions' | 'run_states' | 'artifacts' | 'resolve' | 'total';

export interface RequestTiming {
	name: RequestTimingName;
	duration: number;
}

/** Request-owned durations only: never include query text, identifiers or values. */
export async function measureRequest<T>(
	locals: { requestTimings?: RequestTiming[] },
	name: RequestTimingName,
	operation: () => T | Promise<T>
): Promise<T> {
	if (!locals.requestTimings) return operation();
	const start = performance.now();
	try {
		return await operation();
	} finally {
		locals.requestTimings.push({ name, duration: performance.now() - start });
	}
}

export function serverTimingHeader(timings: RequestTiming[]): string {
	return timings.filter(({ duration }) => Number.isFinite(duration) && duration >= 0)
		.map(({ name, duration }) => `${name};dur=${duration.toFixed(1)}`).join(', ');
}
