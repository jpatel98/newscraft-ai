import { describe, expect, it } from 'vitest';
import { durableFailureReason, durableRunPresentation } from './durable-run-presentation';

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

describe('durableFailureReason', () => {
	it('maps known worker messages to producer-friendly text', () => {
		expect(durableFailureReason('The cumulative input-token reservation budget was reached.')).toBe(
			'Research budget reached before an answer was written.'
		);
		expect(durableFailureReason('The research time or step budget was reached.')).toBe(
			'Research budget reached before an answer was written.'
		);
		expect(
			durableFailureReason('The model request did not complete; its uncertain input was not replayed.')
		).toBe('The model did not respond in time.');
		expect(durableFailureReason('The model request outcome is uncertain; it was not retried.')).toBe(
			'An interrupted step could not be safely retried.'
		);
		expect(durableFailureReason('Hermes run failed.')).toBe('The run stopped before an answer was written.');
	});

	it('falls back to short raw text and never exposes paths, tool ids or traces', () => {
		expect(durableFailureReason('Source site refused the request')).toBe('Source site refused the request.');
		expect(durableFailureReason('boom at /srv/newscraft/worker.py line 12')).toBeNull();
		expect(durableFailureReason('tool call_abc123XYZ failed')).toBeNull();
		expect(durableFailureReason('Traceback (most recent call last):')).toBeNull();
		expect(durableFailureReason('x'.repeat(300))).toBeNull();
		expect(durableFailureReason('')).toBeNull();
		expect(durableFailureReason(null)).toBeNull();
	});
});
