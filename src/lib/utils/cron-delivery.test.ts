import { describe, expect, it } from 'vitest';
import { effectiveRunError, toHermesDeliverTarget, toUiDeliverTarget } from './cron-delivery';

describe('cron delivery helpers', () => {
	it('sends dashboard-only jobs to Hermes as local delivery', () => {
		expect(toHermesDeliverTarget('database')).toBe('local');
		expect(toHermesDeliverTarget(' dashboard ')).toBe('local');
		expect(toHermesDeliverTarget('local')).toBe('local');
	});

	it('shows local Hermes jobs as dashboard delivery in the UI', () => {
		expect(toUiDeliverTarget('local')).toBe('database');
		expect(toUiDeliverTarget('database')).toBe('database');
		expect(toUiDeliverTarget(null)).toBe('database');
	});

	it('does not treat stale dashboard delivery warnings as run failures', () => {
		expect(
			effectiveRunError({
				lastError: null,
				lastDeliveryError: 'no delivery target resolved for deliver=database',
				deliver: 'database'
			})
		).toBeNull();
		expect(
			effectiveRunError({
				lastError: null,
				lastDeliveryError: 'no delivery target resolved for deliver=local',
				deliver: 'local'
			})
		).toBeNull();
	});

	it('keeps real run errors and external delivery errors visible', () => {
		expect(
			effectiveRunError({ lastError: 'source timeout', lastDeliveryError: null, deliver: 'database' })
		).toBe('source timeout');
		expect(
			effectiveRunError({
				lastError: null,
				lastDeliveryError: 'Telegram send failed',
				deliver: 'telegram'
			})
		).toBe('Telegram send failed');
	});

	it('keeps real dashboard-only delivery errors visible', () => {
		expect(
			effectiveRunError({
				lastError: null,
				lastDeliveryError: 'failed to save dashboard report',
				deliver: 'database'
			})
		).toBe('failed to save dashboard report');
	});
});
