import { describe, expect, it } from 'vitest';
import { parseReasoningEffort, reasoningEffortLabel } from './reasoning';

describe('reasoning helpers', () => {
	it('parses supported slash command values', () => {
		expect(parseReasoningEffort('low')).toBe('low');
		expect(parseReasoningEffort('MEDIUM')).toBe('medium');
		expect(parseReasoningEffort('high')).toBe('high');
		expect(parseReasoningEffort('default')).toBe('default');
		expect(parseReasoningEffort('reset')).toBe('default');
		expect(parseReasoningEffort('auto')).toBe('default');
		expect(parseReasoningEffort('extreme')).toBeNull();
		expect(parseReasoningEffort('')).toBeNull();
	});

	it('formats labels for command responses', () => {
		expect(reasoningEffortLabel(undefined)).toBe('Default');
		expect(reasoningEffortLabel('high')).toBe('High');
	});
});
