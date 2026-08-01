import { generateFinalAnswer } from './answer.js';
import {
	isUsableEvidence,
	normalizeEvidence,
	normalizeToolEvidence,
	type EvidenceObject,
	type EvidenceSourceKind
} from './evidence.js';
import { filterEvidenceForResearchContract, isResearchUrlAllowed } from './research-policy.js';
import { NEWSROOM_TOOL_NAMES } from './router.js';
import { evidenceOutputSchema, ToolRegistry, type NewsroomTool, type ToolRunContext, type ToolRunOutput } from './tools.js';
import { resolveModelPolicy } from './model-policy.js';
import { discoverSourceItems, fetchSourceUrl, type DiscoveredSourceItems } from '../tools/sources.js';
import type { SourceItem } from '../tools/source-adapters/index.js';
import {
	extractProviderResponseText,
	normalizeProviderModel,
	providerLabel,
	providerTextEndpoint,
	providerTextUrl,
	type ModelProvider
} from '../util/openai-complete.js';
import { readChatCompletionStream, readOpenAiResponseStream } from '../util/openai-stream.js';
import { extractUrls, firstUrl } from '../util/text.js';
import { assessSourceQuality } from '../util/source-quality.js';
import {
	isCurrentEventQuery,
	formatNewsroomTemporalContext,
	newsroomTimeContext,
	newsroomTimeZone
} from './time-context.js';
import { NEWSROOM_CHARTER } from './roles.js';
import { deriveResearchRequestContract, formatResearchRequestContract, type ResearchRequestContract } from '@newscraft/shared';

const GENERIC_MONITOR_NAME_TERMS = new Set([
	'media',
	'centre',
	'center',
	'news',
	'release',
	'releases',
	'resources',
	'latest'
]);
const NAMED_SOURCE_DOMAINS: Array<{ pattern: RegExp; domain: string }> = [
	{ pattern: /\bCBC(?: News)?\b/i, domain: 'cbc.ca' },
	{ pattern: /\bCTV(?: News)?\b/i, domain: 'ctvnews.ca' },
	{ pattern: /\bReuters\b/i, domain: 'reuters.com' },
	{ pattern: /\b(?:AP|Associated Press|AP News)\b/i, domain: 'apnews.com' },
	{ pattern: /\bToronto Star\b/i, domain: 'thestar.com' },
	{ pattern: /\b(?:The )?Globe and Mail\b/i, domain: 'theglobeandmail.com' },
	{ pattern: /\bGlobal(?:\s*News)?(?:\.ca)?\b/i, domain: 'globalnews.ca' },
	{ pattern: /\bCP24(?:\.com)?\b/i, domain: 'cp24.com' },
	{ pattern: /\bCityNews\b/i, domain: 'citynews.ca' },
	{ pattern: /\bBBC(?: News)?\b/i, domain: 'bbc.com' },
	{ pattern: /\b(?:The )?Guardian\b/i, domain: 'theguardian.com' }
];
const WEB_SEARCH_DEADLINE_MS = 30_000;
const BROAD_WEB_SEARCH_DEADLINE_MS = 75_000;

export function createDefaultToolRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	for (const tool of [
		configuredSourceMonitorTool(),
		sourceFeedFetcherTool(),
		savedResearchReaderTool(),
		openAiWebSearchTool(),
		urlFetchReadTool(),
		browserAutomationProviderTool(),
		pdfTextExtractorTool(),
		newsroomBriefGeneratorTool()
	]) {
		registry.register(tool);
	}
	return registry;
}

function configuredSourceMonitorTool(): NewsroomTool<{ query: string; urls?: string[] }> {
	return {
		name: NEWSROOM_TOOL_NAMES.sourceMonitor,
		description: 'Fetch configured source monitors and normalize current source material into evidence.',
		when_to_use: 'Use for known newsroom monitors, RSS/feed checks, official releases, and latest source scans.',
		category: 'source_monitor',
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				urls: { type: 'array', items: { type: 'string' } }
			},
			required: ['query']
		},
		output_schema: evidenceOutputSchema,
		async run(input, context) {
			const monitors = selectMonitors(input.query, context);
			const urls = [...new Set([...(input.urls || []), ...monitors.map((monitor) => monitor.url)])].slice(0, 8);
			if (!urls.length) {
				return {
					status: 'unavailable',
					limitations: ['No configured source monitor matched the request.']
				};
			}
			const evidence = await fetchSourceIndexEvidence(
				urls,
				NEWSROOM_TOOL_NAMES.sourceMonitor,
				context,
				new Map(monitors.map((monitor) => [monitor.url, monitor.name])),
				new Map(monitors.map((monitor) => [monitor.url, monitor.kind as EvidenceSourceKind]))
			);
			return withStatusFromEvidence(evidence, urls.length);
		}
	};
}

function sourceFeedFetcherTool(): NewsroomTool<{ query: string; urls?: string[] }> {
	return {
		name: NEWSROOM_TOOL_NAMES.sourceFeedFetcher,
		description: 'Fetch source URLs or RSS/feed URLs and normalize them into evidence.',
		when_to_use: 'Use for direct URLs supplied by the user, feeds, releases, and primary source pages.',
		category: 'source_feed_fetcher',
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				urls: { type: 'array', items: { type: 'string' } }
			},
			required: ['query']
		},
		output_schema: evidenceOutputSchema,
		async run(input, context) {
			const urls = [...new Set([...(input.urls || []), ...extractUrls(input.query)])].slice(0, 4);
			if (!urls.length) {
				return {
					status: 'unavailable',
					limitations: ['No URL or feed was supplied for the source/feed fetcher.']
				};
			}
			const evidence = await fetchSourceIndexEvidence(
				urls,
				NEWSROOM_TOOL_NAMES.sourceFeedFetcher,
				context
			);
			return withStatusFromEvidence(evidence, urls.length);
		}
	};
}

const MAX_DISCOVERY_EVIDENCE = 32;
const MAX_ITEMS_PER_SOURCE_INDEX = 5;
const MAX_SOURCE_INDEX_CANDIDATES = 15;

/**
 * Expand feeds and source indexes into item-level evidence so the cited URL is
 * the direct story, never the feed or publisher landing page. Sources are
 * interleaved to keep a broad briefing from being monopolized by one outlet.
 */
export async function fetchSourceIndexEvidence(
	urls: string[],
	toolUsed: string,
	context: ToolRunContext,
	sourceLabels: ReadonlyMap<string, string> = new Map(),
	sourceKinds: ReadonlyMap<string, EvidenceSourceKind> = new Map()
): Promise<EvidenceObject[]> {
	const uniqueUrls = [...new Set(urls)].slice(0, 8);
	const batches = await Promise.all(
		uniqueUrls.map(async (url) => {
			try {
				const discovered = await discoverSourceItems(url, sourceFetchSignal(context.signal));
				return evidenceFromDiscoveredSource(
					discovered,
					toolUsed,
					context,
					sourceLabels.get(url),
					sourceKinds.get(url)
				);
			} catch {
				return [];
			}
		})
	);
	const interleaved: EvidenceObject[] = [];
	for (let itemIndex = 0; itemIndex < MAX_ITEMS_PER_SOURCE_INDEX; itemIndex += 1) {
		for (const batch of batches) {
			const item = batch[itemIndex];
			if (!item) continue;
			interleaved.push(item);
			if (interleaved.length >= MAX_DISCOVERY_EVIDENCE) return interleaved;
		}
	}
	return interleaved;
}

function evidenceFromDiscoveredSource(
	discovered: DiscoveredSourceItems,
	toolUsed: string,
	context: ToolRunContext,
	sourceLabel?: string,
	sourceKindOverride?: EvidenceSourceKind
): EvidenceObject[] {
	const feedLike = discovered.adapter === 'rss' || discovered.adapter === 'atom';
	const candidates = discovered.items
		.filter((item) => !feedLike || !sameSourceUrl(item.url, discovered.sourceUrl))
		.filter((item) => !feedLike || sourceItemMatchesLocation(item, context.researchContract?.location))
		.filter((item) => !feedLike || !isOpinionOrCommentaryItem(item))
		.filter((item) => isAllowedResearchSource(item.url, context.prompt, context.researchContract))
		.sort(compareSourceItemsNewestFirst)
		.slice(0, MAX_SOURCE_INDEX_CANDIDATES);
	const normalized = candidates
		.map((item) => sourceItemToEvidence(item, discovered, toolUsed, context, sourceLabel, sourceKindOverride))
		.filter(isUsableEvidence);
	return filterEvidenceForResearchContract(normalized, context.researchContract)
		.accepted
		.slice(0, MAX_ITEMS_PER_SOURCE_INDEX);
}

function sourceItemToEvidence(
	item: SourceItem,
	discovered: DiscoveredSourceItems,
	toolUsed: string,
	context: ToolRunContext,
	sourceLabel?: string,
	sourceKindOverride?: EvidenceSourceKind
): EvidenceObject {
	const articleUrl = item.url;
	const sourceName = sourceLabel || sourceNameFromUrl(articleUrl);
	const sourceKind = sourceKindOverride ||
		(discovered.adapter === 'rss' || discovered.adapter === 'atom' ? 'news_report' : undefined);
	const evidence = normalizeEvidence({
		source_name: sourceName,
		publisher: sourceName,
		source_url: articleUrl,
		accessed_at: discovered.fetchedAt,
		tool_used: toolUsed,
		title: item.title,
		published_at: item.publishedAt,
		updated_at: item.updatedAt,
		extracted_text: item.contentText || item.summary,
		summary: item.summary || item.contentText,
		confidence: 0.82,
		limitations: [],
		...(sourceKind ? { source_kind: sourceKind } : {}),
		...(sourceKind
			? { page_role: sourceKind === 'official' || sourceKind === 'primary' ? 'official_live' as const : 'article' as const }
			: {}),
		...(context.researchContract?.location || context.newsroomContext?.homeMarket
			? { location: context.researchContract?.location || context.newsroomContext?.homeMarket }
			: {})
	});
	return {
		...evidence,
		provenance: {
			url: discovered.sourceUrl,
			tool: toolUsed,
			source_kind: evidence.source_kind || 'unknown'
		}
	};
}

const LOCATION_ALIASES: Record<string, string[]> = {
	toronto: ['gta', 'scarborough', 'etobicoke', 'north york', 'east york', 'ttc']
};

function sourceItemMatchesLocation(item: SourceItem, location?: string): boolean {
	if (!location?.trim()) return true;
	const normalizedLocation = location.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const text = `${item.title} ${item.summary} ${item.contentText}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
	const terms = [normalizedLocation, ...(LOCATION_ALIASES[normalizedLocation] || [])];
	return terms.some((term) => new RegExp(`(?:^|\\s)${escapeRegularExpression(term).replace(/ /g, '\\s+')}(?:$|\\s)`, 'i').test(text));
}

function isOpinionOrCommentaryItem(item: SourceItem): boolean {
	let path = '';
	try {
		path = new URL(item.url).pathname;
	} catch {
		return false;
	}
	return /\/(?:opinion|columnists?|commentary|letters?)(?:\/|$)/i.test(path);
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareSourceItemsNewestFirst(left: SourceItem, right: SourceItem): number {
	return (Date.parse(right.updatedAt || right.publishedAt || '') || 0) -
		(Date.parse(left.updatedAt || left.publishedAt || '') || 0);
}

function sameSourceUrl(left: string, right: string): boolean {
	try {
		return new URL(left).toString() === new URL(right).toString();
	} catch {
		return left === right;
	}
}

function savedResearchReaderTool(): NewsroomTool<{ latest?: boolean }> {
	return {
		name: NEWSROOM_TOOL_NAMES.researchResultReader,
		description: 'Read saved NewsCraft research updates from the harness repository.',
		when_to_use: 'Use when a user asks for the latest research update, saved research, or previous stored report.',
		category: 'saved_research_reader',
		input_schema: {
			type: 'object',
			properties: { latest: { type: 'boolean' } }
		},
		output_schema: evidenceOutputSchema,
		async run(_input, context) {
			if (!context.repository) {
				return { status: 'unavailable', limitations: ['No harness repository is available to read saved research.'] };
			}
			const report = context.repository.listReports()[0];
			if (!report) return { status: 'unavailable', limitations: ['No saved research updates were found.'] };
			const reportPreview = compactSavedReport(report.markdown);
			return {
				status: 'ok',
				evidence: [
					normalizeEvidence({
						source_name: 'NewsCraft saved research update',
						source_url: `newsroom://research-update/${report.id}`,
						accessed_at: new Date().toISOString(),
						tool_used: NEWSROOM_TOOL_NAMES.researchResultReader,
						title: report.title,
						published_at: report.created_at,
						extracted_text: reportPreview,
						summary: compactToolText(reportPreview, 260),
						confidence: 0.85,
						limitations: ['Saved research output was summarized before reuse to avoid recursive report expansion.'],
						source_kind: 'internal'
					})
				]
			};
		}
	};
}

function openAiWebSearchTool(): NewsroomTool<{ query: string }> {
	return {
		name: NEWSROOM_TOOL_NAMES.webSearch,
		description: 'Use the configured provider web_search tool for broad context and related coverage.',
		when_to_use: 'Use for broad discovery, related coverage, and what other outlets are reporting.',
		category: 'web_search_provider',
		input_schema: {
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query']
		},
		output_schema: evidenceOutputSchema,
		async run(input, context) {
			if (context.documents?.length && !requestsExternalCorroboration(input.query)) {
				return { status: 'ok', evidence: [] };
			}
			const primaryProvider = context.modelProvider || context.config.model_provider;
			const primaryProviderName = providerLabel(primaryProvider);
			const primaryApiKey =
				context.modelApiKey ||
				(primaryProvider === 'openai' ? context.openAiApiKey : context.perplexityApiKey) ||
				'';
			if (!primaryApiKey) {
				return {
					status: 'unavailable',
					limitations: [
						`${primaryProviderName} web_search is not configured because ${providerEnvName(primaryProvider)} is missing.`
					],
					diagnostics: failedSearchDiagnostics(primaryProvider, 'not_configured')
				};
			}
			const modelDecision = resolveModelPolicy(context.config.model_policy, 'web_search', { trigger: context.trigger });
			if (!modelDecision.allowed || !modelDecision.model) {
				context.repository?.appendEvent({
					jobId: context.jobId,
					runId: context.runId,
					agent: 'model_policy',
					kind: 'model.call.skipped',
					payload: {
						task: modelDecision.task,
						tier: modelDecision.tier,
						model: modelDecision.model,
						reason: modelDecision.reason,
						trigger: modelDecision.trigger,
						tool: NEWSROOM_TOOL_NAMES.webSearch
					}
				});
				return {
					status: 'unavailable',
					limitations: [modelDecision.reason]
				};
			}
			let primaryModel: string;
			try {
				primaryModel = normalizeProviderModel(primaryProvider, modelDecision.model);
			} catch (err) {
				return {
					status: 'unavailable',
					limitations: [err instanceof Error ? err.message : String(err)],
					diagnostics: failedSearchDiagnostics(primaryProvider, 'model_configuration')
				};
			}
			context.repository?.appendEvent({
				jobId: context.jobId,
				runId: context.runId,
				agent: 'model_policy',
				kind: 'model.call.selected',
				payload: {
					task: modelDecision.task,
					tier: modelDecision.tier,
					model: modelDecision.model,
					reason: modelDecision.reason,
					trigger: modelDecision.trigger,
					tool: NEWSROOM_TOOL_NAMES.webSearch
				},
				costMetadata: {
					provider: primaryProvider,
					model: primaryModel,
					endpoint: providerTextEndpoint(primaryProvider),
					tool: NEWSROOM_TOOL_NAMES.webSearch,
					estimated: false
				}
			});
			const attempts: NonNullable<ToolRunOutput['diagnostics']>['attempts'] = [];
			const recordOutcome = (
				outcome: InterpretedProviderSearch,
				role: 'primary' | 'retry'
			) => {
				attempts.push({
					role,
					provider: outcome.provider,
					status: outcome.usable ? 'ok' : 'failed',
					latencyMs: outcome.latencyMs,
					sourceCount: outcome.evidence.length,
					...(outcome.upstreamStatus ? { upstreamStatus: outcome.upstreamStatus } : {}),
					...(outcome.failureCategory ? { failureCategory: outcome.failureCategory } : {})
				});
				context.repository?.appendEvent({
					jobId: context.jobId,
					runId: context.runId,
					agent: NEWSROOM_TOOL_NAMES.webSearch,
					kind: outcome.usable ? 'model.call.completed' : 'model.call.failed',
					payload: {
						task: modelDecision.task,
						tier: modelDecision.tier,
						model: outcome.model,
						status: outcome.upstreamStatus ?? 0,
						tool: NEWSROOM_TOOL_NAMES.webSearch,
						attempt: role,
						failure_category: outcome.failureCategory
					},
					costMetadata: {
						provider: outcome.provider,
						model: outcome.model,
						endpoint: providerTextEndpoint(outcome.provider),
						tool: NEWSROOM_TOOL_NAMES.webSearch,
						latency_ms: outcome.latencyMs,
						usage: providerUsageMetadata(outcome.raw),
						estimated: false
					}
				});
			};

			let selected = await interpretProviderWebSearch({
				provider: primaryProvider,
				apiKey: primaryApiKey,
				model: primaryModel,
				query: input.query,
				newsroomContext: context.newsroomContext,
				context
			});
			recordOutcome(selected, 'primary');

			if (!selected.usable && retryableSearchFailure(selected) && !context.signal?.aborted) {
				const retry = await interpretProviderWebSearch({
					provider: primaryProvider,
					apiKey: primaryApiKey,
					model: primaryModel,
					query: input.query,
					newsroomContext: context.newsroomContext,
					context
				});
				recordOutcome(retry, 'retry');
				if (retry.usable) selected = retry;
			}

			const outputText = selected.outputText;
			const answerText = outputText.trim();
			if (isBroadResearchRequest(input.query, context.researchContract) && selected.evidence.length <= 1) {
				const rejectionReasons = selected.discoveryLeads.reduce<Record<string, number>>((counts, item) => {
					const reason = item.rejection_reason || 'unspecified';
					counts[reason] = (counts[reason] || 0) + 1;
					return counts;
				}, {});
				const rejectedPageRoles = selected.discoveryLeads.reduce<Record<string, number>>((counts, item) => {
					const role = item.page_role || 'unspecified';
					counts[role] = (counts[role] || 0) + 1;
					return counts;
				}, {});
				console.warn(
					'NewsCraft broad web research returned thin evidence',
					JSON.stringify({
						traceId: context.runId || null,
						provider: selected.provider,
						upstreamStatus: selected.upstreamStatus || null,
						failureCategory: selected.failureCategory || null,
						outputCharacters: answerText.length,
						evidenceCount: selected.evidence.length,
						datedEvidenceCount: selected.evidence.filter((item) => Boolean(item.published_at || item.updated_at)).length,
						discoveryLeadCount: selected.discoveryLeads.length,
						rejectionReasons,
						rejectedPageRoles
					})
				);
			}
			const streamLimitations = selected.streamFailure
				? ['Live research ended early. Treat this answer as incomplete.']
				: [];
			const diagnostics: NonNullable<ToolRunOutput['diagnostics']> = {
				attempts,
				finalOutcome: selected.evidence.length ? 'sourced' : answerText ? 'unsourced' : 'failed'
			};
				if (selected.evidence.length) {
					return {
						status: 'ok',
						evidence: selected.evidence,
						discovery_leads: selected.discoveryLeads,
						answer: outputText,
					limitations: streamLimitations,
					raw: { output_text: outputText },
					diagnostics
				};
			}
			if (answerText && !isCurrentEventQuery(input.query)) {
					return {
						status: 'ok',
						evidence: selected.evidence,
						discovery_leads: selected.discoveryLeads,
					answer: answerText,
					limitations: ['No usable source links were returned.', ...streamLimitations],
					raw: { output_text: outputText },
					diagnostics
				};
			}
				return {
					status: selected.upstreamStatus && selected.upstreamStatus >= 400 ? 'error' : 'unavailable',
					discovery_leads: selected.discoveryLeads,
				limitations: [
					selected.upstreamStatus
						? publicProviderFailure(providerLabel(selected.provider), selected.upstreamStatus)
						: 'No usable source links were returned.'
				],
				raw: { output_text: outputText },
				diagnostics
			};
		}
	};
}

function urlFetchReadTool(): NewsroomTool<{ url?: string | null }> {
	return {
		name: NEWSROOM_TOOL_NAMES.urlFetchRead,
		description: 'Fetch a single HTTP/HTTPS page, extract readable article text, and preserve provenance.',
		when_to_use: 'Use to read one specific page or article URL in depth (full text and publication date).',
		category: 'custom',
		input_schema: {
			type: 'object',
			properties: { url: { type: ['string', 'null'] } }
		},
		output_schema: evidenceOutputSchema,
		async run(input, context) {
			const url = input.url?.trim() || firstUrl(context.prompt);
			if (!url || !/^https?:\/\//i.test(url)) {
				return { status: 'unavailable', limitations: ['No fetchable HTTP or HTTPS URL was supplied.'] };
			}
			const evidence = await fetchEvidenceUrls([url], NEWSROOM_TOOL_NAMES.urlFetchRead, context);
			return withStatusFromEvidence(evidence, 1);
		}
	};
}

function browserAutomationProviderTool(): NewsroomTool<{ task: string; url?: string | null }> {
	return {
		name: NEWSROOM_TOOL_NAMES.browserAutomation,
		description: 'Optional browser automation provider for direct page interaction.',
		when_to_use: 'Use only for dynamic pages, direct site inspection, clicking, screenshots, or pages that require interaction.',
		category: 'browser_automation_provider',
		input_schema: {
			type: 'object',
			properties: {
				task: { type: 'string' },
				url: { type: ['string', 'null'] }
			},
			required: ['task']
		},
		output_schema: evidenceOutputSchema,
		async run(input) {
			const limitation = /paywall/i.test(input.task)
				? 'This page appears paywalled or requires access that NewsCraft does not have.'
				: /login|captcha/i.test(input.task)
					? 'This page is blocked by a login or browser check that NewsCraft cannot complete.'
				: 'This page could not be opened directly.';
			return { status: 'blocked', limitations: [limitation] };
		}
	};
}

function pdfTextExtractorTool(): NewsroomTool<{ url?: string | null; text?: string | null }> {
	return {
		name: NEWSROOM_TOOL_NAMES.pdfTextExtractor,
		description: 'Read bounded page text from attached documents or supplied source text and preserve page-level provenance.',
		when_to_use: 'Use for PDFs, filings, source documents, pasted text, and document extraction tasks.',
		category: 'pdf_text_extractor',
		input_schema: {
			type: 'object',
			properties: {
				url: { type: ['string', 'null'] },
				text: { type: ['string', 'null'] }
			}
		},
		output_schema: evidenceOutputSchema,
		async run(input, context) {
			if (context.documents?.length) {
				const evidence = documentContextEvidence(context.documents);
				if (evidence.length) return { status: 'ok', evidence };
				return { status: 'unavailable', limitations: ['The attached PDF has no readable text.'] };
			}
			if (input.text?.trim()) {
				return {
					status: 'ok',
					evidence: [
						normalizeEvidence({
							source_name: 'Provided source document',
							source_url: input.url || 'document://provided-source',
							accessed_at: new Date().toISOString(),
							tool_used: NEWSROOM_TOOL_NAMES.pdfTextExtractor,
							title: 'Provided source document, page 1',
							published_at: null,
							extracted_text: input.text,
							summary: compactToolText(input.text, 320),
							confidence: 0.9,
							limitations: ['User-provided document; not independently verified.'],
							source_kind: 'user_document',
							citation_number: 1,
							document_page: 1
						})
					]
				};
			}
			const url = input.url || firstUrl(context.prompt);
			if (!url) return { status: 'unavailable', limitations: ['No PDF/document URL or text was supplied.'] };
			if (/\.pdf(?:$|[?#])/i.test(url)) {
				return {
					status: 'unavailable',
					limitations: ['PDF URL detected, but no PDF parser is registered. Register a richer extractor for PDF text.']
				};
			}
			const evidence = await fetchEvidenceUrls([url], NEWSROOM_TOOL_NAMES.pdfTextExtractor, context);
			return withStatusFromEvidence(evidence, 1);
		}
	};
}

function documentContextEvidence(documents: NonNullable<ToolRunContext['documents']>): EvidenceObject[] {
	let citationNumber = 0;
	const evidence: EvidenceObject[] = [];
	for (const document of documents) {
		for (const page of document.pages) {
			const text = page.text.trim();
			if (!text) continue;
			citationNumber += 1;
			const pageUrl = `${document.downloadUrl || `document://${encodeURIComponent(document.id)}`}#page=${page.pageNumber}`;
			evidence.push(
				normalizeEvidence({
					source_name: document.filename,
					source_url: pageUrl,
					accessed_at: new Date().toISOString(),
					tool_used: NEWSROOM_TOOL_NAMES.pdfTextExtractor,
					title: `${document.filename}, page ${page.pageNumber}`,
					published_at: null,
					extracted_text: text,
					summary: compactToolText(text, 320),
					confidence: 0.9,
					limitations: ['User-provided document; not independently verified.'],
					source_kind: 'user_document',
					citation_number: citationNumber,
					document_page: page.pageNumber
				})
			);
		}
	}
	return evidence;
}

function newsroomBriefGeneratorTool(): NewsroomTool<{ prompt: string; evidence?: EvidenceObject[] }> {
	return {
		name: NEWSROOM_TOOL_NAMES.briefGenerator,
		description: 'Generate a concise producer-ready newsroom brief from evidence objects or supplied notes.',
		when_to_use: 'Use after evidence has been gathered or when a user supplies notes for an internal producer brief.',
		category: 'newsroom_brief_generator',
		input_schema: {
			type: 'object',
			properties: {
				prompt: { type: 'string' },
				evidence: { type: 'array' }
			},
			required: ['prompt']
		},
		output_schema: {
			type: 'object',
			properties: {
				status: { type: 'string', enum: ['ok'] },
				answer: { type: 'string' },
					evidence: evidenceOutputSchema.properties?.evidence || { type: 'array' }
			},
			required: ['status', 'answer']
		},
		async run(input, context) {
			const evidence = input.evidence?.length
				? input.evidence
				: context.evidence.length
					? context.evidence
					: [
							normalizeEvidence({
								source_name: 'User-provided newsroom notes',
								source_url: 'newsroom://provided-notes',
								accessed_at: new Date().toISOString(),
								tool_used: NEWSROOM_TOOL_NAMES.briefGenerator,
								title: 'User-provided newsroom notes',
								published_at: null,
								extracted_text: input.prompt,
								summary: input.prompt,
								confidence: 0.55,
								limitations: ['These are user-provided notes and were not independently verified.'],
								source_kind: 'internal'
							})
						];
			return {
				status: 'ok',
				evidence,
				answer: generateFinalAnswer({
					prompt: input.prompt,
					decision: context.decision,
					evidence,
					limitations: [],
					budget: context.budget
				})
			};
		}
	};
}

export function sourceFetchTimeoutMs(): number {
	const raw = process.env.NEWSROOM_SOURCE_FETCH_TIMEOUT_MS;
	const parsed = raw ? Number(raw) : NaN;
	if (!Number.isFinite(parsed)) return 8_000;
	return Math.max(1_000, parsed);
}

// polite-fetch rate-limits per host at call time but does not serialize
// concurrent same-host calls, so fetch hosts in parallel and URLs within a
// host sequentially.
export async function fetchEvidenceUrls(
	urls: string[],
	toolUsed: string,
	context: ToolRunContext
): Promise<EvidenceObject[]> {
	const fetchableUrls = urls.filter((url) =>
		isAllowedResearchSource(url, context.prompt, context.researchContract)
	);
	const byHost = new Map<string, Array<{ url: string; index: number }>>();
	for (let i = 0; i < fetchableUrls.length; i++) {
		const url = fetchableUrls[i];
		let host: string;
		try {
			host = new URL(url).host.toLowerCase();
		} catch {
			host = url;
		}
		const bucket = byHost.get(host) ?? [];
		bucket.push({ url, index: i });
		byHost.set(host, bucket);
	}

	const results: EvidenceObject[] = new Array(fetchableUrls.length);

	async function fetchBucket(bucket: Array<{ url: string; index: number }>): Promise<void> {
		for (const { url, index } of bucket) {
			try {
				const source = await fetchSourceUrl(url, sourceFetchSignal(context.signal));
				results[index] = fetchedSourceToEvidence(source, toolUsed);
			} catch {
				results[index] = normalizeEvidence({
					source_name: sourceNameFromUrl(url),
					source_url: url,
					accessed_at: new Date().toISOString(),
					tool_used: toolUsed,
					title: sourceNameFromUrl(url),
					published_at: null,
					extracted_text: '',
					summary: '',
					confidence: 0,
					limitations: ['Source could not be read during this run.']
				});
			}
		}
	}

	await Promise.all([...byHost.values()].map(fetchBucket));

	return results;
}

async function enrichMissingPublicationMetadata(
	evidence: EvidenceObject[],
	context: ToolRunContext,
	query: string
): Promise<EvidenceObject[]> {
	const candidates = evidence
		.map((item, index) => ({ item, index }))
		.filter(
			({ item }) =>
				(!item.published_at || /^No source excerpt was returned\b/i.test(item.extracted_text)) &&
				/^https?:\/\//i.test(item.source_url)
		)
		.slice(0, 8);
	if (!candidates.length) return evidence;

	const enriched = [...evidence];
	let cursor = 0;
	const workers = Array.from({ length: Math.min(4, candidates.length) }, async () => {
		while (cursor < candidates.length) {
			const candidate = candidates[cursor];
			cursor += 1;
			try {
				const fetched = await fetchSourceUrl(
					candidate.item.source_url,
					metadataFetchSignal(context.signal)
				);
				const publicationDate =
					fetched.metadata?.publishedAt || publicationDateFromUrl(fetched.url);
				enriched[candidate.index] = {
					...candidate.item,
					published_at: publicationDate || candidate.item.published_at,
					...(fetched.contentText.trim()
						? {
								extracted_text: fetched.contentText,
								summary: relevantFetchedExcerpt(
									fetched.contentText,
									query,
									candidate.item.title,
									fetched.summary || fetched.snippet || candidate.item.summary
								)
							}
						: {})
				};
			} catch {
				// Metadata enrichment is best-effort; an unknown publication date
				// remains unknown rather than failing the whole research run.
			}
		}
	});
	await Promise.all(workers);
	return enriched;
}

function relevantFetchedExcerpt(content: string, query: string, title: string, fallback: string): string {
	const stopwords = new Set([
		'about',
		'after',
		'against',
		'and',
		'from',
		'have',
		'latest',
		'into',
		'outside',
		'report',
		'reports',
		'state',
		'that',
		'their',
		'this',
		'what',
		'when',
		'where',
		'which',
		'with'
	]);
	const terms = [...new Set(`${query} ${title}`.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) || [])]
		.filter((term) => !stopwords.has(term))
		.slice(0, 24);
	const sentences = content
		.replace(/\s+/g, ' ')
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length >= 40);
	let best = '';
	let bestScore = 0;
	for (let index = 0; index < sentences.length; index += 1) {
		const candidate = `${sentences[index]} ${sentences[index + 1] || ''}`.trim();
		const lower = candidate.toLowerCase();
		const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
		if (score <= bestScore) continue;
		best = candidate;
		bestScore = score;
	}
	return compactToolText(bestScore >= 2 ? best : fallback, 900);
}

function metadataFetchSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(Math.min(4_000, sourceFetchTimeoutMs()));
	if (signal && typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
	return timeout;
}

function sourceFetchSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(sourceFetchTimeoutMs());
	if (signal && typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
	return timeout;
}

function fetchedSourceToEvidence(
	source: {
		url: string;
		title: string;
		fetchedAt: string;
		contentText: string;
		summary: string;
		snippet: string;
		statusCode: number | null;
		metadata?: { publishedAt?: string | null } | null;
	},
	toolUsed: string,
	limitations: string[] = []
): EvidenceObject {
	const quality = assessSourceQuality({
		title: source.title,
		text: source.contentText,
		summary: source.summary || source.snippet,
		statusCode: source.statusCode,
		limitations
	});
	const sourceLimitations = [
		...limitations,
		...(quality.usable || !quality.publicNote ? [] : [quality.publicNote])
	];
	const evidence = normalizeEvidence({
		source_name: sourceNameFromUrl(source.url),
		source_url: source.url,
		accessed_at: source.fetchedAt,
		tool_used: toolUsed,
		title: source.title,
		published_at: source.metadata?.publishedAt ?? publicationDateFromUrl(source.url),
		extracted_text: source.contentText,
		summary: source.summary || source.snippet,
		confidence: quality.usable ? 0.75 : 0,
		limitations: [...new Set(sourceLimitations)]
	});
	if (!quality.usable) return { ...evidence, extracted_text: '', summary: '', confidence: 0 };
	return evidence;
}

function publicationDateFromUrl(value: string): string | null {
	let path = '';
	try {
		path = new URL(value).pathname;
	} catch {
		return null;
	}
	const explicit = path.match(/\b(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])\b/);
	const segmented = path.match(/\/(20\d{2})\/(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])(?:\/|$)/);
	const parts = explicit || segmented;
	if (!parts) return null;
	const [, year, rawMonth, rawDay] = parts;
	const month = rawMonth.padStart(2, '0');
	const day = rawDay.padStart(2, '0');
	const candidate = `${year}-${month}-${day}`;
	const parsed = new Date(`${candidate}T00:00:00.000Z`);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate ? null : candidate;
}

function withStatusFromEvidence(evidence: EvidenceObject[], requestedCount: number): ToolRunOutput {
	const useful = evidence.filter(isUsableEvidence);
	const limitations = evidence.flatMap((item) => item.limitations);
	if (useful.length) return { status: 'ok', evidence, limitations };
	return {
		status: evidence.length || requestedCount ? 'unavailable' : 'unavailable',
		evidence,
		limitations: limitations.length ? limitations : ['No usable source text was returned.']
	};
}

function selectMonitors(query: string, context: ToolRunContext) {
	const normalized = query.toLowerCase();
	return [...context.config.source_monitors]
		.filter((monitor) => {
			if (monitor.tags.some((tag) => normalized.includes(tag.toLowerCase()))) return true;
			const terms = monitor.name
				.toLowerCase()
				.split(/\W+/)
				.filter((term) => term.length > 3 && !GENERIC_MONITOR_NAME_TERMS.has(term));
			return terms.some((term) => normalized.includes(term));
		})
		.sort((left, right) => right.priority - left.priority);
}

type ProviderSearchRaw = { error?: { message?: string }; [key: string]: unknown };

type ProviderSearchAttempt = {
	response: Response;
	raw: ProviderSearchRaw;
	streamFailure: string | null;
	latencyMs: number;
};

type InterpretedProviderSearch = {
	provider: ModelProvider;
	model: string;
	raw: ProviderSearchRaw;
	outputText: string;
	evidence: EvidenceObject[];
	discoveryLeads: EvidenceObject[];
	streamFailure: string | null;
	latencyMs: number;
	upstreamStatus?: number;
	failureCategory?: string;
	usable: boolean;
};

async function interpretProviderWebSearch(input: {
	provider: ModelProvider;
	apiKey: string;
	model: string;
	query: string;
	newsroomContext?: ToolRunContext['newsroomContext'];
	context: ToolRunContext;
}): Promise<InterpretedProviderSearch> {
	const startedAt = Date.now();
	const searchSignal = boundedSignal(
		input.context.signal,
		isBroadResearchRequest(input.query, input.context.researchContract)
			? BROAD_WEB_SEARCH_DEADLINE_MS
			: WEB_SEARCH_DEADLINE_MS
	);
	let attempt: ProviderSearchAttempt;
	try {
		attempt = await performProviderWebSearch({
			provider: input.provider,
			apiKey: input.apiKey,
			model: input.model,
			query: input.query,
			stream: false,
				newsroomContext: input.newsroomContext,
				temporalContext: input.context.temporalContext,
				researchContract: input.context.researchContract,
				signal: searchSignal
		});
	} catch (err) {
		if (input.context.signal?.aborted) throw err;
		return {
			provider: input.provider,
			model: input.model,
			raw: {},
			outputText: '',
				evidence: [],
				discoveryLeads: [],
			streamFailure: null,
			latencyMs: Math.max(0, Date.now() - startedAt),
			failureCategory: searchExceptionCategory(err, input.context.signal),
			usable: false
		};
	}

	if (!attempt.response.ok) {
		return {
			provider: input.provider,
			model: input.model,
			raw: attempt.raw,
			outputText: '',
			evidence: [],
			discoveryLeads: [],
			streamFailure: attempt.streamFailure,
			latencyMs: attempt.latencyMs,
			upstreamStatus: attempt.response.status,
			failureCategory: httpFailureCategory(attempt.response.status),
			usable: false
		};
	}

	const providerOutputText = extractProviderResponseText(input.provider, attempt.raw);
	let outputText = canonicalizeTrackingUrlsInText(
		withProviderCitationMarkers(attempt.raw, providerOutputText)
	);
	const researchContract =
		input.context.researchContract ||
		deriveResearchRequestContract(input.query, {
			homeMarket: input.newsroomContext?.homeMarket,
			timezone: input.context.temporalContext?.timeZone,
			preserveBaseSubject: false
		});
	let evidence = normalizeToolEvidence(
		{ evidence: extractProviderWebSources(attempt.raw, providerOutputText) },
		NEWSROOM_TOOL_NAMES.webSearch,
		{
			source_name: `${providerLabel(input.provider)} web_search`,
			accessed_at: new Date().toISOString(),
			confidence: 0.6,
			limitations: ['Broad web-search evidence; verify important claims against primary sources.']
		}
	);
	const discoveryLeads: EvidenceObject[] = [];
	const urlAllowed = evidence.filter((item) => isAllowedResearchSource(item.source_url, input.query, researchContract));
	discoveryLeads.push(
		...evidence
			.filter((item) => !urlAllowed.some((allowed) => allowed.canonical_url === item.canonical_url))
			.map((item) => ({
				...item,
				ledger_status: 'rejected' as const,
				temporal_scope: 'discovery' as const,
				rejection_reason: 'source URL is not allowed by the research contract'
			}))
	);
	const contractFiltered = filterEvidenceForResearchContract(urlAllowed, researchContract);
	evidence = contractFiltered.accepted;
	discoveryLeads.push(...contractFiltered.excluded);
	if (needsPublicationMetadata(input.query) || researchContract.temporalWindow.kind === 'current' || researchContract.temporalWindow.kind === 'relative') {
		evidence = await enrichMissingPublicationMetadata(
			evidence,
			{ ...input.context, signal: searchSignal },
			input.query
		);
	}
	outputText = reconcileDedupedCitationMarkers(outputText, attempt.raw, evidence);
	const currentRequest = isCurrentEventQuery(input.query) || ['current', 'relative'].includes(researchContract.temporalWindow.kind);
	const usable = evidence.length > 0 || (!currentRequest && Boolean(outputText.trim()));
	return {
		provider: input.provider,
		model: input.model,
		raw: attempt.raw,
		outputText,
		evidence,
		discoveryLeads,
		streamFailure: attempt.streamFailure,
		latencyMs: attempt.latencyMs,
		upstreamStatus: attempt.response.status,
		...(usable
			? {}
			: {
					failureCategory:
						attempt.streamFailure && !outputText.trim()
							? 'stream_interrupted'
							: 'no_usable_sources'
				}),
		usable
	};
}

function reconcileDedupedCitationMarkers(
	text: string,
	raw: ProviderSearchRaw,
	evidence: EvidenceObject[]
): string {
	const retainedByUrl = new Map(
		evidence
			.filter((item) => item.citation_number)
			.map((item) => [citationIdentityUrl(item.source_url), item.citation_number!] as const)
	);
	const response = raw as { citations?: Array<string | { url?: string }> };
	const remap = new Map<number, number>();
	const annotations = providerUrlAnnotations(raw);
	if (annotations.length) {
		const originalByUrl = new Map<string, number>();
		for (const annotation of annotations) {
			const providerIdentity = normalizedWebSourceUrl(annotation.url);
			if (!originalByUrl.has(providerIdentity)) originalByUrl.set(providerIdentity, originalByUrl.size + 1);
			const retained = retainedByUrl.get(citationIdentityUrl(annotation.url));
			if (retained) remap.set(originalByUrl.get(providerIdentity)!, retained);
		}
	} else {
		for (const [index, item] of (response.citations || []).entries()) {
			const url = typeof item === 'string' ? item : item.url || '';
			const retained = retainedByUrl.get(citationIdentityUrl(url));
			if (retained) remap.set(index + 1, retained);
		}
	}
	if (!remap.size) return text.replace(/\[(\d+)\]/g, '');
	return text.replace(/\[(\d+)\]/g, (_marker, rawNumber: string) => {
		const replacement = remap.get(Number(rawNumber));
		return replacement ? `[${replacement}]` : '';
	});
}

function citationIdentityUrl(value: string): string {
	try {
		const url = new URL(normalizedWebSourceUrl(value));
		url.hash = '';
		return url.toString().replace(/\/$/, '').toLowerCase();
	} catch {
		return value.trim().replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
	}
}

function retryableSearchFailure(outcome: InterpretedProviderSearch): boolean {
	return (
		!outcome.usable &&
		outcome.failureCategory !== 'aborted' &&
		outcome.failureCategory !== 'timeout' &&
		outcome.failureCategory !== 'no_usable_sources' &&
		outcome.failureCategory !== 'not_configured' &&
		outcome.failureCategory !== 'model_configuration'
	);
}

function searchExceptionCategory(err: unknown, parentSignal?: AbortSignal): string {
	if (parentSignal?.aborted) return 'aborted';
	const name = err instanceof Error ? err.name : '';
	const message = err instanceof Error ? err.message : String(err);
	if (name === 'TimeoutError' || /timeout|timed out/i.test(message)) return 'timeout';
	if (name === 'AbortError' || /abort/i.test(message)) return 'timeout';
	return 'network';
}

function httpFailureCategory(status: number): string {
	if (status === 408) return 'http_408';
	if (status === 429) return 'http_429';
	if (status >= 500) return 'http_5xx';
	if (status === 401 || status === 403) return 'authentication';
	return 'http_other';
}

function failedSearchDiagnostics(
	provider: ModelProvider,
	failureCategory: string
): NonNullable<ToolRunOutput['diagnostics']> {
	return {
		attempts: [
			{
				role: 'primary',
				provider,
				status: 'failed',
				latencyMs: 0,
				sourceCount: 0,
				failureCategory
			}
		],
		finalOutcome: 'failed'
	};
}

async function performProviderWebSearch(input: {
	provider: ModelProvider;
	apiKey: string;
	model: string;
	query: string;
	stream: boolean;
	newsroomContext?: ToolRunContext['newsroomContext'];
	temporalContext?: ToolRunContext['temporalContext'];
	researchContract?: ResearchRequestContract;
	signal?: AbortSignal;
	onAnswerDelta?: (delta: string) => void;
}): Promise<ProviderSearchAttempt> {
	const startedAtMs = Date.now();
	const response = await fetch(providerTextUrl(input.provider), {
		method: 'POST',
		headers: {
			authorization: `Bearer ${input.apiKey}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify(
			webSearchRequestBody({
				provider: input.provider,
				model: input.model,
				stream: input.stream,
					query: input.query,
					input: webSearchPrompt(input.query, input.newsroomContext, input.temporalContext, input.researchContract),
					researchContract: input.researchContract
			})
		),
		signal: input.signal
	});
	let raw: ProviderSearchRaw = {};
	let streamFailure: string | null = null;
	if (response.ok && input.stream && response.body && input.onAnswerDelta) {
		const streamed = await (
			input.provider === 'openai'
				? readOpenAiResponseStream(response.body, input.onAnswerDelta)
				: readChatCompletionStream(response.body, input.onAnswerDelta)
		).catch((err) => ({
			response: null,
			status: 'interrupted' as const,
			error: err instanceof Error ? err.message : String(err)
		}));
		raw = (streamed.response as ProviderSearchRaw) || {};
		if (streamed.status === 'failed' || streamed.status === 'interrupted') {
			streamFailure = streamed.error || `web search stream ${streamed.status}`;
		}
	} else {
		raw = (await response.json().catch(() => ({}))) as ProviderSearchRaw;
	}
	return {
		response,
		raw,
		streamFailure,
		latencyMs: Math.max(0, Date.now() - startedAtMs)
	};
}

function webSearchRequestBody(input: {
	provider: ModelProvider;
	model: string;
	stream: boolean;
	input: string;
	query: string;
	researchContract?: ResearchRequestContract;
}): Record<string, unknown> {
	if (input.provider === 'openai') {
		const body: Record<string, unknown> = {
			model: input.model,
			instructions: NEWSROOM_CHARTER,
			stream: input.stream,
			reasoning: { effort: 'low' },
			max_output_tokens: webSearchOutputTokenLimit(input.query, input.researchContract),
			tools: [{ type: 'web_search' }],
			tool_choice: 'required',
			input: input.input
		};
		body.include = ['web_search_call.action.sources'];
		return body;
	}
	return {
		model: input.model,
		stream: input.stream,
		messages: [
			{
				role: 'system',
				content: NEWSROOM_CHARTER
			},
			{ role: 'user', content: input.input }
		],
		...sonarSearchFilters(input.query, input.researchContract)
	};
}

function webSearchOutputTokenLimit(query: string, researchContract?: ResearchRequestContract): number {
	const requestedCount =
		researchContract?.requestedItemCount ||
		requestedItemCountFromText(query) ||
		(isBroadResearchRequest(query, researchContract) ? 5 : 1);
	if (requestedCount >= 8) return 4_800;
	if (requestedCount >= 5) return 4_000;
	if (requestedCount >= 3) return 3_200;
	return 2_000;
}

function requestedItemCountFromText(query: string): number | null {
	const range = query.match(/\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b[\s\S]{0,80}\b(?:items?|sources?|announcements?|stories?|updates?)\b/i);
	if (range) return Math.min(12, Math.max(Number(range[1]), Number(range[2])));
	const numeric = query.match(/\b(\d{1,2})\b[\s\S]{0,80}\b(?:items?|sources?|announcements?|stories?|updates?)\b/i);
	if (numeric) return Math.min(12, Number(numeric[1]));
	const wordValues: Record<string, number> = {
		one: 1,
		two: 2,
		three: 3,
		four: 4,
		five: 5,
		six: 6,
		seven: 7,
		eight: 8,
		nine: 9,
		ten: 10,
		eleven: 11,
		twelve: 12
	};
	const word = query.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b[\s\S]{0,80}\b(?:items?|sources?|announcements?|stories?|updates?)\b/i);
	return word ? wordValues[word[1].toLowerCase()] : null;
}

function isBroadResearchRequest(query: string, researchContract?: ResearchRequestContract): boolean {
	return (
		(researchContract?.requestedItemCount || 0) >= 3 ||
		(requestedItemCountFromText(query) || 0) >= 3 ||
		/\b(?:briefing|roundup|top stories|assignment desk|scan broadly|major outlets|multiple outlets)\b/i.test(query) ||
		/\blatest\b[\s\S]{0,60}\b(?:news|stories|updates)\b/i.test(query)
	);
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (signal && typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
	return timeout;
}

function webSearchPrompt(
	query: string,
	newsroomContext?: ToolRunContext['newsroomContext'],
	temporalContext?: ToolRunContext['temporalContext'],
	researchContract?: ResearchRequestContract
): string {
	const resolvedTimeZone = validTimeZone(newsroomContext?.timezone) || newsroomTimeZone();
	const timeContext = temporalContext
		? formatNewsroomTemporalContext(temporalContext)
		: newsroomTimeContext({ timeZone: resolvedTimeZone });
	return [
		timeContext,
		...(newsroomContext?.homeMarket
			? [`Prioritize locally relevant evidence for ${newsroomContext.homeMarket} when the request is local.`]
			: []),
		...(newsroomContext?.preferredDomains?.length
			? [
					`Prefer useful evidence from these newsroom domains when relevant, without excluding stronger official or direct evidence: ${newsroomContext.preferredDomains.join(', ')}.`
					]
				: []),
		...(researchContract ? [`Structured request contract (binding): ${formatResearchRequestContract(researchContract)}`] : []),
		'Apply the Browsing workflow in the newsroom charter. Treat this provider as discovery and retrieval, not as the final editor.',
		'Use provider-neutral natural-language queries. Work through broad discovery, official/public-impact checks when relevant, and focused corroboration before stopping when results become repetitive.',
		'Open promising result pages and prefer readable article or official pages over snippets, homepages, section pages, search pages, player pages, forums, or social posts.',
		'Return normalized research notes for the synthesis desk, not a standalone user-facing roundup. For each useful candidate, preserve its canonical URL, page role, source date or event date, a short supporting passage, and any uncertainty or access limitation.',
		'Complete the research now. Do not ask for scope confirmation when a safe, bounded interpretation can answer the request; state the interpretation briefly and proceed.',
		'For a broad request, make a safe bounded interpretation, state it briefly, and use a representative mix of directly relevant sources.',
		'Lead with the direct answer. Add confirmed facts, disagreement, uncertainty, or a comparison table only when each is relevant; do not emit empty boilerplate sections.',
		'Tell the user what the research found before discussing what could not be confirmed. A partial, source-backed answer is more useful than a generic access or verification disclaimer.',
		'For latest, current, or today requests, report the newest concrete findings in newest-to-oldest order. Include the event time or date and the key event facts when the sources provide them.',
		'Do not substitute instructions to check, consult, visit, or monitor a source page for the requested update.',
		isCurrentEventQuery(query)
			? `Do not add a Current as of label; NewsCraft adds the local label outside the provider response.`
			: 'Do not add a Current as of label unless the answer depends on changing or time-sensitive facts.',
		'Current-as-of and source-access times are context only. Never present either as a source publication date; use each source\'s actual publication date or state that the date is unknown.',
		'Summarize the freshest usable result first, using concrete event dates or timestamps only when they matter to the answer.',
		isCurrentEventQuery(query)
			? 'For today/current/latest requests, cite only pages whose real publication timestamp is within the requested period, except an official live status or schedule page. Do not use an older dated article as today’s news.'
			: '',
		'Prefer primary or official sources and directly relevant local/reputable outlets.',
		'Attribute reputable reporting when direct evidence is unavailable and state material uncertainty.',
		'If no reliable readable source confirms a current-events or claim-verification request, clearly label any relevant search result as an unverified lead instead of presenting it as fact.',
		'When reputable sources disagree, attribute each conclusion separately. Do not group sources or investigators together if their findings materially differ.',
		'For local meetings or other obscure events, distinguish agendas and previews from confirmed outcomes; if no official minutes or first-party account confirms what happened, state that limitation explicitly.',
		'Mention a paywall, block, CAPTCHA, unavailable page, or unreadable source only when the user requested that specific source or when it materially prevents answering. Do not mention failed candidate pages when other readable evidence answers the request.',
		'If the request is an ambiguous follow-up and there is no clear referent, ask a brief clarifying question instead of guessing.',
		'Avoid forums, social threads, old PDFs, and loosely related background unless the request asks for them.',
		'Keep the answer concise, readable, and organized for a normal person scanning local news.',
		'Use clean Markdown when it improves scanning: short headings, bullets, numbered lists, and compact tables are allowed.',
		'For multi-story requests, use clear sections and bullets. Use Latest context only if older items matter.',
		'Use bold only for short labels inside prose or table headers. Do not write the literal word "Bold".',
		'Do not say "ordered by freshness", "source-led", "local outlet reports", or "according to" unless it is essential to avoid overstating a claim.',
		'Do not end with unsolicited offers, next-step suggestions, or phrases like "If you’d like..." unless the user explicitly asks for options.',
		'Do not include a Sources/References section, raw URLs, domain parentheticals, or outlet posting-time roundups; source links are captured separately.',
		'If the request asks for tables, standings, rows, columns, or tabular output, prefer a valid GitHub-flavored Markdown table with a header separator row.',
		`Request: ${query}`
	].join('\n');
}

function sonarSearchFilters(query: string, researchContract?: ResearchRequestContract): Record<string, unknown> {
	const domains = [...new Set([...(researchContract?.namedDomains || []), ...namedDomainsForQuery(query)])];
	const recency = sonarRecencyForQuery(query);
	return {
		...(domains.length ? { search_domain_filter: domains } : {}),
		...(recency ? { search_recency_filter: recency } : {})
	};
}

function needsPublicationMetadata(query: string): boolean {
	return (
		isCurrentEventQuery(query) ||
		/\b(?:publication date|when .*published|compare|contrast|coverage|reporting|reports?|verify|fact[- ]?check)\b/i.test(
			query
		)
	);
}

export function isAllowedResearchSource(
	url: string,
	_query: string,
	researchContract?: ResearchRequestContract
): boolean {
	return isResearchUrlAllowed(url, researchContract);
}

function namedDomainsForQuery(query: string): string[] {
	const named = NAMED_SOURCE_DOMAINS.filter((entry) => entry.pattern.test(query)).map((entry) => entry.domain);
	const explicit = [...query.matchAll(/\b(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ca|org|net|news))\b/gi)].map(
		(match) => match[1].toLowerCase()
	);
	return [...new Set([...named, ...explicit])].slice(0, 20);
}

function sonarRecencyForQuery(query: string): 'day' | 'week' | undefined {
	if (/\b(today|tonight|right now|latest|newest|past 24 hours?|last 24 hours?)\b/i.test(query)) return 'day';
	if (/\b(this week|past week|last week|past 7 days?|last 7 days?)\b/i.test(query)) return 'week';
	return undefined;
}

function requestsExternalCorroboration(query: string): boolean {
	return /\b(verify|corroborate|fact[- ]?check|search (?:the )?web|search externally|external sources?|other outlets?|broader coverage)\b/i.test(
		query
	);
}

function validTimeZone(value?: string): string | null {
	if (!value) return null;
	try {
		new Intl.DateTimeFormat('en', { timeZone: value }).format();
		return value;
	} catch {
		return null;
	}
}

function hasPrimaryEvidence(evidence: EvidenceObject[]): boolean {
	return evidence.some((item) => item.source_kind === 'official' || item.source_kind === 'primary');
}

function providerEnvName(provider: ModelProvider): string {
	return provider === 'openai' ? 'OPENAI_API_KEY' : 'PERPLEXITY_API_KEY';
}

function publicProviderFailure(_providerName: string, status: number): string {
	if (status === 401 || status === 403) {
		return 'Live research is temporarily unavailable.';
	}
	if (status === 429) {
		return 'Live research is temporarily busy. Try again shortly.';
	}
	return 'Live research could not finish right now.';
}

function providerUsageMetadata(raw: unknown): Record<string, number> | null {
	const usage = (raw as { usage?: Record<string, unknown> })?.usage;
	if (!usage || typeof usage !== 'object') return null;
	const metadata: Record<string, number> = {};
	for (const [key, value] of Object.entries(usage)) {
		if (typeof value === 'number' && Number.isFinite(value)) metadata[key] = value;
	}
	return Object.keys(metadata).length ? metadata : null;
}

type ProviderSearchResult = {
	url?: string;
	title?: string;
	snippet?: string;
	content?: string;
	date?: string;
	last_updated?: string;
};

function extractProviderWebSources(raw: unknown, outputText: string) {
	const actionSources: WebSourceCandidate[] = [];
	const citedSources: WebSourceCandidate[] = [];
	const response = raw as {
		citations?: Array<string | ProviderSearchResult>;
		search_results?: ProviderSearchResult[];
		fetch_url_results?: ProviderSearchResult[];
		output?: Array<{
			type?: string;
			search_results?: ProviderSearchResult[];
			fetch_url_results?: ProviderSearchResult[];
			action?: { sources?: Array<{ url?: string; title?: string; source?: string }> };
			content?: Array<{
				type?: string;
				search_results?: ProviderSearchResult[];
				fetch_url_results?: ProviderSearchResult[];
				annotations?: Array<{
					type?: string;
					url?: string;
					title?: string;
					start_index?: number;
					end_index?: number;
				}>;
			}>;
		}>;
	};
	const resultByUrl = new Map<string, ProviderSearchResult>();
	const rememberResult = (source: ProviderSearchResult) => {
		if (source.url && !resultByUrl.has(normalizedWebSourceUrl(source.url))) {
			resultByUrl.set(normalizedWebSourceUrl(source.url), source);
		}
	};
	const annotations = providerUrlAnnotations(raw);
	const annotationNumberByUrl = new Map<string, number>();
	for (const annotation of annotations) {
		const key = normalizedWebSourceUrl(annotation.url);
		if (!annotationNumberByUrl.has(key)) annotationNumberByUrl.set(key, annotationNumberByUrl.size + 1);
	}
	for (const source of response.search_results || []) rememberResult(source);
	for (const source of response.fetch_url_results || []) rememberResult(source);
	for (const [index, citation] of (response.citations || []).entries()) {
		const url = (typeof citation === 'string' ? citation : citation.url) || response.search_results?.[index]?.url;
		if (!url) continue;
		if (typeof citation !== 'string') rememberResult(citation);
		const matchingResult = resultByUrl.get(normalizedWebSourceUrl(url));
		const title = (typeof citation === 'string' ? '' : citation.title) || matchingResult?.title || url;
		const snippet = (typeof citation === 'string' ? '' : citation.snippet) || matchingResult?.snippet || '';
		const publishedAt =
			(typeof citation === 'string' ? null : citation.date || citation.last_updated) ||
			matchingResult?.date ||
			matchingResult?.last_updated ||
			null;
		if (annotations.length) continue;
		citedSources.push(webSource(url, title, snippet, { citationNumber: index + 1, publishedAt }));
	}
	for (const source of response.search_results || []) {
		if (!source.url) continue;
		rememberResult(source);
		actionSources.push(
			webSource(source.url, source.title || source.url, source.snippet || '', {
				publishedAt: source.date || source.last_updated || null
			})
		);
	}
	for (const source of response.fetch_url_results || []) {
		if (!source.url) continue;
		rememberResult(source);
		actionSources.push(
			webSource(source.url, source.title || source.url, source.content || source.snippet || '', {
				publishedAt: source.date || source.last_updated || null
			})
		);
	}
	const seenAnnotationUrls = new Set<string>();
	for (const item of response.output || []) {
		for (const source of item.search_results || []) {
			if (!source.url) continue;
			rememberResult(source);
			actionSources.push(
				webSource(source.url, source.title || source.url, source.snippet || '', {
					publishedAt: source.date || source.last_updated || null
				})
			);
		}
		for (const source of item.fetch_url_results || []) {
			if (!source.url) continue;
			rememberResult(source);
			actionSources.push(
				webSource(source.url, source.title || source.url, source.content || source.snippet || '', {
					publishedAt: source.date || source.last_updated || null
				})
			);
		}
		for (const source of item.action?.sources || []) {
			if (!source.url) continue;
			actionSources.push(webSource(source.url, source.title || source.source || source.url));
		}
		for (const content of item.content || []) {
			for (const source of content.search_results || []) {
				if (!source.url) continue;
				rememberResult(source);
				actionSources.push(
					webSource(source.url, source.title || source.url, source.snippet || '', {
						publishedAt: source.date || source.last_updated || null
					})
				);
			}
			for (const source of content.fetch_url_results || []) {
				if (!source.url) continue;
				rememberResult(source);
				actionSources.push(
					webSource(source.url, source.title || source.url, source.content || source.snippet || '', {
						publishedAt: source.date || source.last_updated || null
					})
				);
			}
			const contentAnnotations = orderedUrlAnnotations(content.annotations || []);
			for (const [annotationIndex, annotation] of contentAnnotations.entries()) {
				const key = normalizedWebSourceUrl(annotation.url);
				if (!annotationNumberByUrl.has(key)) annotationNumberByUrl.set(key, annotationNumberByUrl.size + 1);
				if (seenAnnotationUrls.has(key)) continue;
				seenAnnotationUrls.add(key);
				const matchingResult = resultByUrl.get(key);
				const supportingExcerpt = supportingExcerptForAnnotation(
					outputText,
					annotation,
					annotationIndex,
					contentAnnotations.length
				);
				citedSources.push(
					webSource(
						annotation.url,
						annotation.title || matchingResult?.title || annotation.url,
						matchingResult?.content || matchingResult?.snippet || supportingExcerpt,
						{
							citationNumber: annotationNumberByUrl.get(key),
							supportingExcerpt,
							publishedAt:
								matchingResult?.date ||
								matchingResult?.last_updated ||
								publicationDateFromCitationText(supportingExcerpt)
						}
					)
				);
			}
		}
	}
	return citedSources.length
		? uniqueWebSources(citedSources).sort(
				(left, right) => (left.citation_number ?? Number.MAX_SAFE_INTEGER) - (right.citation_number ?? Number.MAX_SAFE_INTEGER)
			)
		: uniqueWebSources(actionSources);
}

function withProviderCitationMarkers(raw: unknown, outputText: string): string {
	if (!outputText.trim()) return outputText;
	const annotations = providerUrlAnnotations(raw);
	if (!annotations.length) return outputText;
	const numberByUrl = new Map<string, number>();
	const insertions: Array<{ index: number; marker: string }> = [];
	for (const annotation of annotations) {
		const key = normalizedWebSourceUrl(annotation.url);
		if (!numberByUrl.has(key)) numberByUrl.set(key, numberByUrl.size + 1);
		const citationNumber = numberByUrl.get(key);
		if (!citationNumber) continue;
		const end = Math.max(0, Math.min(outputText.length, Number(annotation.end_index ?? outputText.length)));
		const nearby = outputText.slice(Math.max(0, end - 8), Math.min(outputText.length, end + 8));
		if (new RegExp(`\\[${citationNumber}\\]`).test(nearby)) continue;
		insertions.push({ index: end, marker: ` [${citationNumber}]` });
	}
	if (!insertions.length) return outputText;
	let marked = outputText;
	for (const insertion of insertions.sort((left, right) => right.index - left.index)) {
		marked = `${marked.slice(0, insertion.index)}${insertion.marker}${marked.slice(insertion.index)}`;
	}
	return marked;
}

function providerUrlAnnotations(raw: unknown): UrlAnnotation[] {
	const response = raw as {
		output?: Array<{
			content?: Array<{ annotations?: UrlAnnotation[] }>;
		}>;
	};
	return (response.output || []).flatMap((item) =>
		(item.content || []).flatMap((content) => orderedUrlAnnotations(content.annotations || []))
	);
}

type UrlAnnotation = {
	type?: string;
	url: string;
	title?: string;
	start_index?: number;
	end_index?: number;
};

function orderedUrlAnnotations(annotations: Array<UrlAnnotation | { url?: string }>): UrlAnnotation[] {
	return annotations
		.filter(
			(annotation): annotation is UrlAnnotation =>
				(annotation as UrlAnnotation).type === 'url_citation' &&
				typeof annotation.url === 'string' &&
				/^https?:\/\//i.test(annotation.url)
		)
		.sort((left, right) => {
			const leftStart = Number(left.start_index ?? Number.MAX_SAFE_INTEGER);
			const rightStart = Number(right.start_index ?? Number.MAX_SAFE_INTEGER);
			if (leftStart !== rightStart) return leftStart - rightStart;
			return normalizedWebSourceUrl(left.url).localeCompare(normalizedWebSourceUrl(right.url));
		});
}

type WebSourceCandidate = {
	source_name: string;
	source_url: string;
	title: string;
	extracted_text: string;
	summary: string;
	limitations: string[];
	confidence: number;
	published_at: string | null;
	citation_number?: number;
	supporting_excerpt?: string;
};

function uniqueWebSources(sources: WebSourceCandidate[]): WebSourceCandidate[] {
	const seenUrls = new Set<string>();
	const seenCitationNumbers = new Set<number>();
	return sources.filter((source) => {
		const key = normalizedWebSourceUrl(source.source_url);
		if (source.citation_number) {
			if (seenCitationNumbers.has(source.citation_number)) return false;
			seenCitationNumbers.add(source.citation_number);
			seenUrls.add(key);
			return true;
		}
		if (seenUrls.has(key)) return false;
		seenUrls.add(key);
		return true;
	});
}

function webSource(
	url: string,
	title: string,
	snippet = '',
	options: { publishedAt?: string | null; citationNumber?: number; supportingExcerpt?: string } = {}
): WebSourceCandidate {
	const canonicalUrl = normalizedWebSourceUrl(url);
	const sourceSummary = compactToolText(snippet, 220);
	const titleSummary = compactWebSourceTitle(title, canonicalUrl, 220);
	const summary = sourceSummary || titleSummary;
	return {
		source_name: sourceNameFromUrl(canonicalUrl),
		source_url: canonicalUrl,
		title,
		extracted_text: summary || titleSummary || 'Web search cited this source.',
		summary: summary || titleSummary || 'Web search cited this source; verify the source page directly before publication.',
		limitations: ['Provider web_search result; cite and verify source page before publication.'],
		confidence: 0.6,
		published_at: options.publishedAt || publicationDateFromUrl(canonicalUrl),
		citation_number: options.citationNumber,
		supporting_excerpt: options.supportingExcerpt
	};
}

function normalizedWebSourceUrl(value: string): string {
	try {
		const parsed = new URL(value);
		const queryParts = parsed.search
			.slice(1)
			.split('&')
			.filter(Boolean)
			.filter((part) => {
				const separator = part.indexOf('=');
				const rawKey = separator >= 0 ? part.slice(0, separator) : part;
				const rawValue = separator >= 0 ? part.slice(separator + 1) : null;
				const key = decodeQueryComponent(rawKey);
				if (isTrackingQueryParam(key)) return false;
				if (rawValue === null || rawValue === '') return true;
				return !['undefined', 'null'].includes(decodeQueryComponent(rawValue).trim().toLowerCase());
			});
		parsed.search = queryParts.length ? `?${queryParts.join('&')}` : '';
		const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
		return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}${parsed.hash}`;
	} catch {
		return value.trim().replace(/\/$/, '').toLowerCase();
	}
}

function decodeQueryComponent(value: string): string {
	try {
		return decodeURIComponent(value.replace(/\+/g, ' '));
	} catch {
		return value;
	}
}

function canonicalizeTrackingUrlsInText(value: string): string {
	return value.replace(/https?:\/\/[^\s)\]]+/gi, (url) => {
		const trailing = url.match(/[.,;:!?]+$/)?.[0] || '';
		const core = trailing ? url.slice(0, -trailing.length) : url;
		return `${normalizedWebSourceUrl(core)}${trailing}`;
	});
}

function isTrackingQueryParam(key: string): boolean {
	return /^(?:utm_[a-z0-9_]+|fbclid|gclid|gbraid|wbraid|igshid|mc_cid|mc_eid|mkt_tok)$/i.test(key);
}

function compactWebSourceTitle(title: string, url: string, maxLength: number): string {
	const value = title.trim();
	if (/^https?:\/\//i.test(value) || value === url) {
		try {
			const parsed = new URL(url);
			const path = parsed.pathname.replace(/\/$/, '');
			const label = `${parsed.hostname.replace(/^www\./, '')}${path && path !== '/' ? path : ''}`;
			if (label.length <= maxLength) return label;
			return `${label.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
		} catch {
			/* fall through */
		}
	}
	return compactToolText(value, maxLength);
}

function supportingExcerptForAnnotation(
	outputText: string,
	annotation: UrlAnnotation,
	annotationIndex = 0,
	annotationCount = 1
): string {
	const start = Math.max(0, Math.min(outputText.length, Number(annotation.start_index ?? 0)));
	const end = Math.max(start, Math.min(outputText.length, Number(annotation.end_index ?? start)));
	const hasOffsets = Number.isFinite(annotation.start_index) && Number.isFinite(annotation.end_index) && end > start;
	if (hasOffsets) {
		const annotated = compactToolText(outputText.slice(start, end), 420);
		if (annotated.length >= 20) return annotated;

		const before = outputText.slice(0, start);
		const after = outputText.slice(end);
		const sentenceStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '));
		const sentenceEndCandidates = [after.indexOf('\n'), after.indexOf('. '), after.indexOf('! '), after.indexOf('? ')]
			.filter((index) => index >= 0);
		const sentenceEnd = sentenceEndCandidates.length ? Math.min(...sentenceEndCandidates) + end + 1 : outputText.length;
		const surrounding = compactToolText(outputText.slice(sentenceStart >= 0 ? sentenceStart + 1 : 0, sentenceEnd), 420);
		if (surrounding.length >= 20) return surrounding;
	}

	// Some Responses API web-search annotations preserve URL order but omit
	// character offsets. The canonical browsing prompt requests one normalized
	// research note per candidate, so map ordered citations to ordered
	// substantive notes before giving up on the source passage.
	const orderedNotes = outputText
		.split(/\n+/)
		.map((line) => compactToolText(line, 420))
		.filter((line) => line.length >= 40 && !/^(?:research notes?|sources?|findings?|latest producer roundup)$/i.test(line));
	if (annotationCount > 0 && orderedNotes.length >= annotationCount) {
		return orderedNotes[Math.min(annotationIndex, orderedNotes.length - 1)];
	}
	return '';
}

function publicationDateFromCitationText(value: string): string | null {
	const match = value.match(
		/\b(?:published|posted|updated)(?:\s+on)?\s*(?:at\s+)?(?:[:,-]\s*)?((?:20\d{2}-\d{2}-\d{2})|(?:[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+20\d{2}))/i
	);
	if (!match) return null;
	const normalized = match[1].replace(/\b([A-Z][a-z]{2})\./, '$1');
	const parsed = new Date(normalized);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function compactToolText(value: string, maxLength: number): string {
	const cleaned = value
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/[*_~>`#-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function compactSavedReport(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	const summaryIndex = lines.findIndex((line) => /^##\s+Summary\s*$/i.test(line.trim()));
	let source = markdown;
	if (summaryIndex >= 0) {
		const collected: string[] = [];
		for (const line of lines.slice(summaryIndex + 1)) {
			if (/^##\s+/.test(line.trim())) break;
			collected.push(line);
		}
		source = collected.join('\n').trim() || markdown;
	}
	return compactToolText(source, 700);
}

function sourceNameFromUrl(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return value;
	}
}
