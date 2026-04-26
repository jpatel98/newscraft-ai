export interface DatedConvo {
	id: string;
	title: string;
	updatedAt: number;
	pinned: number;
	systemPrompt: string | null;
}

export interface GroupedConvos<T extends DatedConvo> {
	pinned: T[];
	today: T[];
	yesterday: T[];
	last7: T[];
	earlier: T[];
}

// Local-day boundaries — `now` is passed in so tests can pin time, and so the
// grouping is stable across a render that straddles midnight.
function startOfDay(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

export function groupByDate<T extends DatedConvo>(
	convos: readonly T[],
	now: number = Date.now()
): GroupedConvos<T> {
	const todayStart = startOfDay(now);
	const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
	const sevenDaysStart = todayStart - 7 * 24 * 60 * 60 * 1000;

	const out: GroupedConvos<T> = {
		pinned: [],
		today: [],
		yesterday: [],
		last7: [],
		earlier: []
	};

	for (const c of convos) {
		if (c.pinned) {
			out.pinned.push(c);
			continue;
		}
		const t = c.updatedAt;
		if (t >= todayStart) out.today.push(c);
		else if (t >= yesterdayStart) out.yesterday.push(c);
		else if (t >= sevenDaysStart) out.last7.push(c);
		else out.earlier.push(c);
	}

	return out;
}
