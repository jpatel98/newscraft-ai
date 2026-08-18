import { describe, expect, it } from 'vitest';
import { assessHermesReadiness, describeHermesReadiness } from './hermes-readiness.js';

function readyFixture() {
	return {
		ok: true,
		service: 'newscraft-hermes-chat',
		toolset: 'hermes-acp',
		tools: ['browser_navigate', 'browser_snapshot'],
		runtime: { provider: 'custom', model: 'fixture-model', endpointMode: 'explicit' },
		capabilities: {
			standard: true,
			browser: true,
			webResearch: true,
			terminal: true,
			files: true,
			codeExecution: true,
			delegation: true,
			skills: true,
			memory: true,
			accountIsolation: {
				tenantHeader: 'x-newscraft-tenant-key',
				contextLocalHome: true,
				stableTaskKey: true,
				persistentDockerWorkspace: true,
				isolatedBrowserProfiles: true
			},
			webExtraction: {
				configured: true,
				backend: 'newscraft-local',
				archiveProvider: 'wayback',
				tool: true,
				leadVerificationTool: true
			},
			webLeadVerification: { configured: true, tool: true, bounded: true }
		}
	};
}

describe('Hermes readiness contract', () => {
	it('accepts the complete NewsCraft app contract', () => {
		expect(assessHermesReadiness(readyFixture())).toEqual({ ok: true, failures: [] });
	});

	it('names every failed contract without including configuration values', () => {
		const fixture = readyFixture();
		fixture.capabilities.accountIsolation.stableTaskKey = false;
		fixture.capabilities.webExtraction.configured = false;

		const assessment = assessHermesReadiness(fixture);
		expect(assessment.ok).toBe(false);
		expect(assessment.failures.map((failure) => failure.code)).toEqual([
			'account_isolation',
			'web_extraction'
		]);
		expect(describeHermesReadiness(assessment)).toContain('account isolation');
		expect(describeHermesReadiness(assessment)).toContain('web extraction');
		expect(describeHermesReadiness(assessment)).not.toContain('fixture-model');
	});
});
