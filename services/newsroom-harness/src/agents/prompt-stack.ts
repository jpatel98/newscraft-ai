import type { ConversationContext, DocumentContext, NewsroomContext, ResearchRequestContract } from '@newscraft/shared';
import { formatResearchRequestContract } from '@newscraft/shared';
import { formatConversationContext } from './grounded-conversation.js';
import { NEWSROOM_CHARTER } from './roles.js';
import { formatNewsroomTemporalContext, type NewsroomTemporalContext } from './time-context.js';
import { skillCatalog, type NewsroomSkill } from './skills.js';
import type { ToolBudgetSnapshot } from './budget.js';

export interface PromptToolCatalogItem {
	name: string;
	when_to_use: string;
}

export interface NewsroomPromptLayerInput {
	request: string;
	temporalContext: NewsroomTemporalContext;
	contract?: ResearchRequestContract;
	conversationContext?: ConversationContext;
	newsroomContext?: NewsroomContext;
	documents?: DocumentContext[];
	skills: readonly NewsroomSkill[];
	tools: readonly PromptToolCatalogItem[];
	iteration: number;
	maxIterations: number;
	budget: ToolBudgetSnapshot;
	observations?: readonly string[];
	gaps?: readonly string[];
	disclosedSkill?: string;
}

export interface NewsroomPromptLayers {
	stable: string;
	context: string;
	volatile: string;
}

/**
 * Assemble prompts by volatility so stable newsroom policy is not mixed with
 * request state or mutable loop observations. The exact current request and
 * request-scoped timestamp are always included in the context/volatile layers.
 */
export function buildNewsroomPromptLayers(input: NewsroomPromptLayerInput): NewsroomPromptLayers {
	const stable = [
		NEWSROOM_CHARTER,
		'Capability policy:',
		'- Only choose registered read-only newsroom capabilities listed below.',
		'- Never choose shell, filesystem, messaging, scheduling, memory-writing, deployment, or browser-control actions.',
		'- Research actions collect normalized evidence; they do not write user-facing mini-answers.',
		'- The current user request and request-scoped temporal contract are authoritative over prior wording.',
		'Skill catalog (progressive disclosure; select a skill before relying on its full procedure):',
		skillCatalog(input.skills) || '- none',
		'Read-only capability catalog:',
		input.tools.map((tool) => `- ${tool.name}: ${tool.when_to_use}`).join('\n') || '- none'
	].join('\n');

	const context = [
		'Authoritative current user request:',
		bound(input.request, 1800),
		...(input.contract
			? ['Structured request contract:', formatResearchRequestContract(input.contract)]
			: []),
		...(input.newsroomContext
			? [
					'Producer context:',
					`- Timezone: ${input.newsroomContext.timezone}`,
					...(input.newsroomContext.homeMarket ? [`- Home market: ${input.newsroomContext.homeMarket}`] : []),
					...(input.newsroomContext.preferredDomains?.length
						? [`- Preferred domains: ${input.newsroomContext.preferredDomains.join(', ')}`]
						: [])
				]
			: []),
		...(input.conversationContext
			? ['Conversation context:', bound(formatConversationContext(input.conversationContext), 5200)]
			: []),
		...(input.documents?.length
			? ['Private attached-document context:', bound(documentContext(input.documents), 8000)]
			: []),
		...(input.disclosedSkill ? ['Disclosed skill procedure:', bound(input.disclosedSkill, 1800)] : [])
	].join('\n');

	const volatile = [
		'Volatile request state:',
		formatNewsroomTemporalContext(input.temporalContext),
		`Loop iteration: ${input.iteration} of ${input.maxIterations}.`,
		`Tool budget: ${JSON.stringify(input.budget)}`,
		...(input.observations?.length
			? ['Normalized observations since the request began:', ...input.observations.slice(-8).map((item) => `- ${bound(item, 600)}`)]
			: ['Normalized observations since the request began: - none']),
		...(input.gaps?.length
			? ['Remaining contract gaps:', ...input.gaps.slice(0, 8).map((item) => `- ${bound(item, 400)}`)]
			: ['Remaining contract gaps: - none recorded']),
		'Choose at most two independent read-only research actions for this iteration, or choose synthesize when another action is unlikely to improve the verified answer.'
	].join('\n');

	return { stable, context, volatile };
}

export function renderNewsroomPromptLayers(layers: NewsroomPromptLayers): string {
	return [
		'[Stable newsroom policy and capability catalog]',
		layers.stable,
		'[Conversation, producer, document, and request context]',
		layers.context,
		'[Volatile time, session, budget, and loop state]',
		layers.volatile
	].join('\n\n');
}

function documentContext(documents: DocumentContext[]): string {
	return documents
		.flatMap((document) => [
			`Document ${document.id}: ${document.filename} (${document.pageCount} pages)`,
			...document.pages.slice(0, 12).map((page) => `Page ${page.pageNumber}: ${bound(page.text, 1200)}`)
		])
		.join('\n');
}

function bound(value: string, limit: number): string {
	const normalized = value.replace(/\s+/g, ' ').trim();
	return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trim()}…`;
}
