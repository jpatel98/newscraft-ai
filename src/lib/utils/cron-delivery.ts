export interface JobRunErrorFields {
	lastError?: string | null;
	lastDeliveryError?: string | null;
	deliver?: string | null;
}

function normalizeDeliverTarget(value: string | null | undefined): string {
	return String(value ?? '')
		.trim()
		.toLowerCase();
}

function isDashboardOnlyDeliverTarget(value: string | null | undefined): boolean {
	const normalized = normalizeDeliverTarget(value);
	return !normalized || normalized === 'local' || normalized === 'database' || normalized === 'dashboard';
}

export function toUiDeliverTarget(value: string | null | undefined): string {
	return isDashboardOnlyDeliverTarget(value) ? 'database' : String(value ?? '').trim();
}

function isMissingDashboardDeliveryTargetError(value: string | null | undefined): boolean {
	return /^no delivery target resolved for deliver=(database|local|dashboard)$/i.test(
		String(value ?? '').trim()
	);
}

export function effectiveRunError(job: JobRunErrorFields | null | undefined): string | null {
	if (!job) return null;
	if (job.lastError) return job.lastError;
	if (isDashboardOnlyDeliverTarget(job.deliver) && isMissingDashboardDeliveryTargetError(job.lastDeliveryError)) {
		return null;
	}
	return job.lastDeliveryError ?? null;
}
