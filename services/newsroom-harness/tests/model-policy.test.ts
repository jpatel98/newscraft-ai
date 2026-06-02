import { describe, expect, it } from 'vitest';
import { createModelPolicyConfig, resolveModelPolicy } from '../src/agents/model-policy.js';

describe('model policy', () => {
	it('blocks scheduled synthesis and web search by default', () => {
		const policy = createModelPolicyConfig();

		expect(resolveModelPolicy(policy, 'scheduled_research_update', { trigger: 'schedule' })).toMatchObject({
			allowed: false,
			tier: 'none',
			reason: 'Scheduled model calls are disabled by model policy.'
		});
		expect(resolveModelPolicy(policy, 'web_search', { trigger: 'schedule' })).toMatchObject({
			allowed: false,
			tier: 'standard',
			reason: 'Scheduled web search is disabled by model policy.'
		});
	});

	it('allows manual routine research through the mini tier', () => {
		const policy = createModelPolicyConfig();

		expect(resolveModelPolicy(policy, 'manual_research_update', { trigger: 'manual' })).toMatchObject({
			allowed: true,
			tier: 'mini',
			model: 'gpt-5.4-mini'
		});
	});

	it('uses the nano tier for title generation', () => {
		const policy = createModelPolicyConfig();

		expect(resolveModelPolicy(policy, 'title', { trigger: 'manual' })).toMatchObject({
			allowed: true,
			tier: 'nano',
			model: 'gpt-5.4-nano'
		});
	});

	it('uses scheduled model calls only when explicitly enabled', () => {
		const policy = createModelPolicyConfig({
			tasks: { scheduled_research_update: { tier: 'mini', reasoning_effort: 'low' } },
			scheduled: { allow_model_calls: true }
		});

		expect(resolveModelPolicy(policy, 'scheduled_research_update', { trigger: 'schedule' })).toMatchObject({
			allowed: true,
			tier: 'mini',
			model: 'gpt-5.4-mini'
		});
	});

	it('ignores abstract gateway model names unless overrides are explicitly allowed', () => {
		const policy = createModelPolicyConfig({
			allow_request_model_override: true,
			models: { mini: 'configured-mini' }
		});

		expect(
			resolveModelPolicy(policy, 'manual_research_update', {
				trigger: 'manual',
				requestedModel: 'newsroom-agent'
			})
		).toMatchObject({ model: 'configured-mini' });
		expect(
			resolveModelPolicy(policy, 'manual_research_update', {
				trigger: 'manual',
				requestedModel: 'gpt-explicit'
			})
		).toMatchObject({ model: 'gpt-explicit' });
	});
});
