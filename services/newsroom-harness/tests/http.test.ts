import { describe, expect, it } from 'vitest';
import { requestTraceId } from '../src/util/http.js';

describe('harness request trace extraction', () => {
	it('prefers body trace id over request headers', () => {
		const traceId = requestTraceId(
			{
				'x-request-id': 'header-trace-000',
				'x-trace-id': 'header-trace-111'
			},
			'body-trace-222'
		);

		expect(traceId).toBe('body-trace-222');
	});

	it('falls back to request headers in header preference order', () => {
		const requestId = requestTraceId({ 'x-request-id': 'from-request-id' }, undefined);
		const traceId = requestTraceId({ 'x-trace-id': 'from-trace-id' }, undefined);
		const vercelId = requestTraceId({ 'x-vercel-trace-id': 'from-vercel-id' }, undefined);

		expect(requestId).toBe('from-request-id');
		expect(traceId).toBe('from-trace-id');
		expect(vercelId).toBe('from-vercel-id');
	});

	it('rejects invalid trace ids', () => {
		expect(requestTraceId({}, 'bad id!')).toBeUndefined();
		expect(requestTraceId({ 'x-request-id': 'bad id!' })).toBeUndefined();
	});
});
