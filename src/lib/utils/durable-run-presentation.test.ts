import { describe, expect, it } from 'vitest';
import { durableRunPresentation } from './durable-run-presentation';

describe('durable run presentation', () => {
	it('uses truthful actions for stopping, stopped, and failed runs', () => {
		expect(durableRunPresentation('cancel_requested')).toEqual({
			label: 'Stopping', terminal: false, retryable: false
		});
		expect(durableRunPresentation('cancelled')).toEqual({
			label: 'Stopped', terminal: true, retryable: false
		});
		expect(durableRunPresentation('failed')).toEqual({
			label: 'Reply failed', terminal: true, retryable: true
		});
	});

	it('does not add a terminal banner to complete or unknown runs', () => {
		expect(durableRunPresentation('complete')).toBeNull();
		expect(durableRunPresentation(null)).toBeNull();
	});
});
