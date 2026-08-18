import { HERMES_TOOLSET } from './hermes.js';

export const NEWSCRAFT_HERMES_SERVICE = 'newscraft-hermes-chat' as const;

export type HermesReadinessFailureCode =
	| 'response'
	| 'service'
	| 'toolset'
	| 'runtime'
	| 'browser_tools'
	| 'standard_tools'
	| 'account_isolation'
	| 'web_extraction'
	| 'lead_verification';

export interface HermesReadinessFailure {
	code: HermesReadinessFailureCode;
	contract: string;
}

export interface HermesReadinessAssessment {
	ok: boolean;
	failures: HermesReadinessFailure[];
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Evaluate the contract that the NewsCraft app requires before it sends an
 * authenticated run to Hermes. The result contains stable, non-secret
 * contract names so operators can identify drift without logging config.
 */
export function assessHermesReadiness(input: unknown): HermesReadinessAssessment {
	const value = recordValue(input);
	const tools = Array.isArray(value?.tools)
		? new Set(value.tools.filter((tool): tool is string => typeof tool === 'string'))
		: new Set<string>();
	const runtime = recordValue(value?.runtime);
	const capabilities = recordValue(value?.capabilities);
	const accountIsolation = recordValue(capabilities?.accountIsolation);
	const webExtraction = recordValue(capabilities?.webExtraction);
	const leadVerification = recordValue(capabilities?.webLeadVerification);
	const failures: HermesReadinessFailure[] = [];

	const requireContract = (
		condition: boolean,
		code: HermesReadinessFailureCode,
		contract: string
	): void => {
		if (!condition) failures.push({ code, contract });
	};

	requireContract(value?.ok === true, 'response', 'Hermes reports ok:true');
	requireContract(
		value?.service === NEWSCRAFT_HERMES_SERVICE,
		'service',
		`service is ${NEWSCRAFT_HERMES_SERVICE}`
	);
	requireContract(
		value?.toolset === HERMES_TOOLSET,
		'toolset',
		`toolset is ${HERMES_TOOLSET}`
	);
	requireContract(
		Boolean(stringValue(runtime?.provider)) &&
			Boolean(stringValue(runtime?.model)) &&
			runtime?.endpointMode === 'explicit',
		'runtime',
		'runtime has one explicit provider and model endpoint'
	);
	requireContract(
		tools.has('browser_navigate') && tools.has('browser_snapshot'),
		'browser_tools',
		'browser navigation and snapshot tools are available'
	);
	requireContract(
		capabilities?.standard === true &&
			[
				'browser',
				'webResearch',
				'terminal',
				'files',
				'codeExecution',
				'delegation',
				'skills',
				'memory'
			].every((name) => capabilities?.[name] === true),
		'standard_tools',
		'standard Hermes capability groups are ready'
	);
	requireContract(
		accountIsolation?.tenantHeader === 'x-newscraft-tenant-key' &&
			accountIsolation?.contextLocalHome === true &&
			accountIsolation?.stableTaskKey === true &&
			accountIsolation?.persistentDockerWorkspace === true &&
			accountIsolation?.isolatedBrowserProfiles === true,
		'account_isolation',
		'account isolation is context-local and persistent per tenant'
	);
	requireContract(
		webExtraction?.configured === true &&
			webExtraction?.backend === 'newscraft-local' &&
			webExtraction?.archiveProvider === 'wayback' &&
			webExtraction?.tool === true &&
			webExtraction?.leadVerificationTool === true,
		'web_extraction',
		'NewsCraft web extraction is configured with bounded archive fallback'
	);
	requireContract(
		leadVerification?.configured === true &&
			leadVerification?.tool === true &&
			leadVerification?.bounded === true,
		'lead_verification',
		'lead verification is configured, available, and bounded'
	);

	return { ok: failures.length === 0, failures };
}

export function describeHermesReadiness(assessment: HermesReadinessAssessment): string {
	if (assessment.ok) return 'Hermes readiness contract passed.';
	return `Hermes readiness contract failed: ${assessment.failures
		.map((failure) => failure.contract)
		.join('; ')}.`;
}
