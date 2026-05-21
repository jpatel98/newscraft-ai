import type { HarnessRepository } from '../db/repository.js';
import type { NewsroomAgentConfig } from './harness-config.js';
import type { EvidenceObject } from './evidence.js';
import type { RouteDecision } from './router.js';
import type { ToolBudgetSnapshot } from './budget.js';

export type ToolCategory =
	| 'source_feed_fetcher'
	| 'source_monitor'
	| 'mission_result_reader'
	| 'web_search_provider'
	| 'browser_automation_provider'
	| 'pdf_text_extractor'
	| 'newsroom_brief_generator'
	| 'custom';

export interface JsonSchema {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	required?: string[];
	enum?: string[];
	additionalProperties?: boolean;
	[key: string]: unknown;
}

export interface ToolRunContext {
	prompt: string;
	decision: RouteDecision;
	config: NewsroomAgentConfig;
	evidence: EvidenceObject[];
	budget: ToolBudgetSnapshot;
	repository?: HarnessRepository;
	openAiApiKey?: string;
	signal?: AbortSignal;
}

export interface ToolRunOutput {
	status: 'ok' | 'unavailable' | 'blocked' | 'error';
	evidence?: EvidenceObject[];
	answer?: string;
	limitations?: string[];
	raw?: unknown;
}

export interface NewsroomTool<Input = unknown, Output extends ToolRunOutput = ToolRunOutput> {
	name: string;
	description: string;
	when_to_use: string;
	category: ToolCategory;
	input_schema: JsonSchema;
	output_schema: JsonSchema;
	run(input: Input, context: ToolRunContext): Promise<Output>;
}

export class ToolRegistry {
	private readonly tools = new Map<string, NewsroomTool>();

	register(tool: NewsroomTool): void {
		if (!tool.name.trim()) throw new Error('Tool name is required');
		if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
		this.tools.set(tool.name, tool);
	}

	get(name: string): NewsroomTool | undefined {
		return this.tools.get(name);
	}

	require(name: string): NewsroomTool {
		const tool = this.get(name);
		if (!tool) throw new Error(`Tool not registered: ${name}`);
		return tool;
	}

	list(): NewsroomTool[] {
		return [...this.tools.values()];
	}

	forCategory(category: ToolCategory): NewsroomTool[] {
		return this.list().filter((tool) => tool.category === category);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}
}

export const evidenceOutputSchema: JsonSchema = {
	type: 'object',
	properties: {
		status: { type: 'string', enum: ['ok', 'unavailable', 'blocked', 'error'] },
		evidence: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					source_name: { type: 'string' },
					source_url: { type: 'string' },
					accessed_at: { type: 'string' },
					tool_used: { type: 'string' },
					title: { type: 'string' },
					published_at: { type: ['string', 'null'] },
					extracted_text: { type: 'string' },
					summary: { type: 'string' },
					confidence: { type: 'number' },
					limitations: { type: 'array', items: { type: 'string' } }
				},
				required: [
					'source_name',
					'source_url',
					'accessed_at',
					'tool_used',
					'title',
					'published_at',
					'extracted_text',
					'summary',
					'confidence',
					'limitations'
				]
			}
		},
		limitations: { type: 'array', items: { type: 'string' } }
	},
	required: ['status']
};
