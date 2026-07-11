import { generateFinalAnswer } from './answer.js';
import { isUsableEvidence, normalizeEvidence, normalizeToolEvidence, type EvidenceObject } from './evidence.js';
import { NEWSROOM_TOOL_NAMES } from './router.js';
import { evidenceOutputSchema, ToolRegistry, type NewsroomTool, type ToolRunContext, type ToolRunOutput } from './tools.js';
import { resolveModelPolicy } from './model-policy.js';
import { fetchSourceUrl } from '../tools/sources.js';
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
	newsroomTimeContext,
	newsroomTimeZone
} from './time-context.js';

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
	{ pattern: /\bGlobal News\b/i, domain: 'globalnews.ca' },
	{ pattern: /\bCityNews\b/i, domain: 'citynews.ca' },
	{ pattern: /\bBBC(?: News)?\b/i, domain: 'bbc.com' },
	{ pattern: /\b(?:The )?Guardian\b/i, domain: 'theguardian.com' }
];

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
			const urls = [...new Set([...(input.urls || []), ...monitors.map((monitor) => monitor.url)])].slice(0, 3);
			if (!urls.length) {
				return {
					status: 'unavailable',
					limitations: ['No configured source monitor matched the request.']
				};
			}
			const evidence = await fetchEvidenceUrls(urls, NEWSROOM_TOOL_NAMES.sourceMonitor, context);
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
			const evidence = await fetchEvidenceUrls(urls, NEWSROOM_TOOL_NAMES.sourceFeedFetcher, context);
			return withStatusFromEvidence(evidence, urls.length);
		}
	};
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
			const provider = context.modelProvider || context.config.model_provider;
			const providerName = providerLabel(provider);
			const apiKey = context.modelApiKey || (provider === 'openai' ? context.openAiApiKey : '');
			if (!apiKey) {
				return {
					status: 'unavailable',
					limitations: [`${providerName} web_search is not configured because ${providerEnvName(provider)} is missing.`]
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
			let requestModel: string;
			try {
				requestModel = normalizeProviderModel(provider, modelDecision.model);
			} catch (err) {
				return {
					status: 'unavailable',
					limitations: [err instanceof Error ? err.message : String(err)]
				};
			}
			const endpoint = providerTextEndpoint(provider);
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
					provider,
					model: requestModel,
					endpoint,
					tool: NEWSROOM_TOOL_NAMES.webSearch,
					estimated: false
				}
			});
			const highRiskVerification = provider === 'perplexity' && needsOfficialSourceRetry(input.query);
			const streamDeltas = Boolean(context.onAnswerDelta) && !highRiskVerification;
			const recordAttempt = (attempt: ProviderSearchAttempt, kind: 'initial' | 'official_source') => {
				context.repository?.appendEvent({
					jobId: context.jobId,
					runId: context.runId,
					agent: NEWSROOM_TOOL_NAMES.webSearch,
					kind: attempt.response.ok && !attempt.streamFailure ? 'model.call.completed' : 'model.call.failed',
					payload: {
						task: modelDecision.task,
						tier: modelDecision.tier,
						model: requestModel,
						status: attempt.response.status,
						tool: NEWSROOM_TOOL_NAMES.webSearch,
						attempt: kind
					},
					costMetadata: {
						provider,
						model: requestModel,
						endpoint,
						tool: NEWSROOM_TOOL_NAMES.webSearch,
						latency_ms: attempt.latencyMs,
						usage: providerUsageMetadata(attempt.raw),
						estimated: false
					}
				});
			};
			const attempt = await performProviderWebSearch({
				provider,
				apiKey,
				model: requestModel,
				query: input.query,
				stream: streamDeltas,
				newsroomContext: context.newsroomContext,
				signal: context.signal,
				onAnswerDelta: streamDeltas ? context.onAnswerDelta : undefined
			});
			recordAttempt(attempt, 'initial');
			if (!attempt.response.ok) {
				return {
					status: 'error',
					limitations: [publicProviderFailure(providerName, attempt.response.status)],
					raw: attempt.raw
				};
			}
			let raw = attempt.raw;
			let streamFailure = attempt.streamFailure;
			let outputText = extractProviderResponseText(provider, raw);
			if (streamFailure && !outputText.trim()) {
				return {
					status: 'error',
					limitations: [`${providerName} web_search stream failed: ${streamFailure}`],
					raw
				};
			}
			let evidence = normalizeToolEvidence(
				{ evidence: extractProviderWebSources(raw, outputText) },
				NEWSROOM_TOOL_NAMES.webSearch,
				{
					source_name: `${providerName} web_search`,
					accessed_at: new Date().toISOString(),
					confidence: 0.6,
					limitations: ['Broad web-search evidence; verify important claims against primary sources.']
				}
			);
			if (highRiskVerification && !hasPrimaryEvidence(evidence)) {
				const retry = await performProviderWebSearch({
					provider,
					apiKey,
					model: requestModel,
					query: input.query,
					stream: false,
					newsroomContext: context.newsroomContext,
					signal: context.signal,
					officialSourceOnly: true
				});
				recordAttempt(retry, 'official_source');
				if (retry.response.ok) {
					const retryText = extractProviderResponseText(provider, retry.raw);
					const retryEvidence = normalizeToolEvidence(
						{ evidence: extractProviderWebSources(retry.raw, retryText) },
						NEWSROOM_TOOL_NAMES.webSearch,
						{
							source_name: `${providerName} web_search`,
							accessed_at: new Date().toISOString(),
							confidence: 0.65,
							limitations: ['Broad web-search evidence; verify important claims against primary sources.']
						}
					);
					if (hasPrimaryEvidence(retryEvidence)) {
						if (retryText.trim()) {
							raw = retry.raw;
							streamFailure = retry.streamFailure;
							outputText = retryText;
							evidence = retryEvidence;
						} else {
							evidence = appendUniqueEvidence(evidence, retryEvidence);
						}
					}
				}
			}
			if (highRiskVerification && !hasPrimaryEvidence(evidence)) {
				const primaryStatus =
					'**Primary-source status:** I did not find readable official or direct evidence in this search, so treat the attributed reporting as provisional.';
				outputText = outputText.trim() ? `${outputText.trim()}\n\n${primaryStatus}` : primaryStatus;
			}
			const answerText = outputText.trim();
			const streamLimitations = streamFailure
				? [`Web search stream ended early: ${streamFailure}. The answer may be incomplete.`]
				: [];
			if (evidence.length) {
				return { status: 'ok', evidence, answer: outputText, limitations: streamLimitations, raw: { output_text: outputText } };
			}
			if (answerText) {
				return {
					status: 'ok',
					evidence,
					answer: answerText,
					limitations: [`${providerName} web_search returned answer text but no cited sources could be extracted.`, ...streamLimitations],
					raw: { output_text: outputText }
				};
			}
			return {
				status: 'unavailable',
				limitations: [`${providerName} web_search returned no cited sources.`],
				raw: { output_text: outputText }
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
			const limitation = /login|captcha|paywall/i.test(input.task)
				? 'Browser task stopped because it appears to require login, CAPTCHA, or paywall access.'
				: 'No browser automation provider is configured inside this harness; register one when direct page interaction is needed.';
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
	const byHost = new Map<string, Array<{ url: string; index: number }>>();
	for (let i = 0; i < urls.length; i++) {
		const url = urls[i];
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

	const results: EvidenceObject[] = new Array(urls.length);

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
		published_at: source.metadata?.publishedAt ?? null,
		extracted_text: source.contentText,
		summary: source.summary || source.snippet,
		confidence: quality.usable ? 0.75 : 0,
		limitations: [...new Set(sourceLimitations)]
	});
	if (!quality.usable) return { ...evidence, extracted_text: '', summary: '', confidence: 0 };
	return evidence;
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

async function performProviderWebSearch(input: {
	provider: ModelProvider;
	apiKey: string;
	model: string;
	query: string;
	stream: boolean;
	newsroomContext?: ToolRunContext['newsroomContext'];
	officialSourceOnly?: boolean;
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
				officialSourceOnly: input.officialSourceOnly,
				input: webSearchPrompt(input.query, input.newsroomContext, input.officialSourceOnly)
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
	officialSourceOnly?: boolean;
}): Record<string, unknown> {
	if (input.provider === 'openai') {
		const body: Record<string, unknown> = {
			model: input.model,
			stream: input.stream,
			reasoning: { effort: 'low' },
			tools: [{ type: 'web_search' }],
			tool_choice: 'auto',
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
				content: [
					'You are NewsCraft AI, a newsroom research assistant.',
					'Use Perplexity Sonar web grounding to answer with concise, source-backed current information.',
					'Do not invent sources. If reliable results are missing, say so plainly.'
				].join(' ')
			},
			{ role: 'user', content: input.input }
		],
		...sonarSearchFilters(input.query, input.officialSourceOnly)
	};
}

function webSearchPrompt(
	query: string,
	newsroomContext?: ToolRunContext['newsroomContext'],
	officialSourceOnly = false
): string {
	const resolvedTimeZone = validTimeZone(newsroomContext?.timezone) || newsroomTimeZone();
	const timeContext = newsroomTimeContext({ timeZone: resolvedTimeZone });
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
		'Search for source material relevant to this newsroom request.',
		'Lead with the direct answer. Add confirmed facts, disagreement, uncertainty, or a comparison table only when each is relevant; do not emit empty boilerplate sections.',
		isCurrentEventQuery(query)
			? `Do not add a Current as of label; NewsCraft adds the local label outside the provider response.`
			: 'Do not add a Current as of label unless the answer depends on changing or time-sensitive facts.',
		'Current-as-of and source-access times are context only. Never present either as a source publication date; use each source\'s actual publication date or state that the date is unknown.',
		'Summarize the freshest usable result first, using concrete event dates or timestamps only when they matter to the answer.',
		'Prefer primary or official sources and directly relevant local/reputable outlets.',
		officialSourceOnly
			? 'Use official or direct first-party sources for the answer. If none are readable, state that primary confirmation was not found.'
			: 'Attribute reputable reporting when direct evidence is unavailable and state material uncertainty.',
		'If no reliable readable source confirms a current-events or claim-verification request, say that plainly instead of giving a confident unsourced answer.',
		'For local meetings or other obscure events, distinguish agendas and previews from confirmed outcomes; if no official minutes or first-party account confirms what happened, state that limitation explicitly.',
		'If a requested source is paywalled, blocked, CAPTCHA-protected, unavailable, empty, or cannot be read, flag that limitation honestly without technical details.',
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

function sonarSearchFilters(query: string, officialSourceOnly = false): Record<string, unknown> {
	const domains = officialSourceOnly ? officialDomainsForQuery(query) : namedDomainsForQuery(query);
	const recency = sonarRecencyForQuery(query);
	return {
		...(domains.length ? { search_domain_filter: domains } : {}),
		...(recency ? { search_recency_filter: recency } : {})
	};
}

function namedDomainsForQuery(query: string): string[] {
	const named = NAMED_SOURCE_DOMAINS.filter((entry) => entry.pattern.test(query)).map((entry) => entry.domain);
	const explicit = [...query.matchAll(/\b(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ca|org|net|news))\b/gi)].map(
		(match) => match[1].toLowerCase()
	);
	return [...new Set([...named, ...explicit])].slice(0, 20);
}

function officialDomainsForQuery(query: string): string[] {
	const domains: string[] = [];
	if (/\bfifa\b/i.test(query)) domains.push('fifa.com');
	if (/\b(bank of canada|boc)\b/i.test(query)) domains.push('bankofcanada.ca');
	if (/\b(elections? canada|federal election)\b/i.test(query)) domains.push('elections.ca');
	if (/\b(rcmp|royal canadian mounted police)\b/i.test(query)) domains.push('rcmp-grc.gc.ca');
	if (/\b(toronto police|tps)\b/i.test(query)) domains.push('tps.ca');
	if (/\b(toronto|city hall|city council|mayor)\b/i.test(query)) domains.push('toronto.ca');
	if (/\bontario\b/i.test(query)) domains.push('ontario.ca');
	if (/\b(canada|federal government|parliament)\b/i.test(query)) domains.push('canada.ca');
	return [...new Set(domains)].slice(0, 20);
}

function sonarRecencyForQuery(query: string): 'day' | 'week' | undefined {
	if (/\b(today|tonight|right now|past 24 hours?|last 24 hours?)\b/i.test(query)) return 'day';
	if (/\b(this week|past week|last week|past 7 days?|last 7 days?)\b/i.test(query)) return 'week';
	return undefined;
}

function needsOfficialSourceRetry(query: string): boolean {
	if (/\b(verify|verification|confirm|fact[- ]?check|official sources?|primary sources?)\b/i.test(query)) return true;
	if (/\b(government|parliament|minister|ministry|department|agency|police|sheriff|court|legal|lawsuit|charges?|arrest|elections?|ballot|vote count)\b/i.test(query)) return true;
	if (/\b(schedule|fixtures?|kick[- ]?off|tip[- ]?off)\b/i.test(query)) return true;
	return /\b(games?|matches?)\b[\s\S]*\b(today|tonight|tomorrow|this week)\b/i.test(query);
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

function appendUniqueEvidence(evidence: EvidenceObject[], additions: EvidenceObject[]): EvidenceObject[] {
	const seen = new Set(evidence.map((item) => item.source_url.toLowerCase()));
	return [
		...evidence,
		...additions.filter((item) => {
			const key = item.source_url.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
	];
}

function providerEnvName(provider: ModelProvider): string {
	return provider === 'openai' ? 'OPENAI_API_KEY' : 'PERPLEXITY_API_KEY';
}

function publicProviderFailure(providerName: string, status: number): string {
	if (status === 401 || status === 403) {
		return `The configured research provider (${providerName}) rejected the request. Check the provider key and model configuration.`;
	}
	if (status === 429) {
		return `The configured research provider (${providerName}) is rate limited. Try again once quota is available.`;
	}
	return `The configured research provider (${providerName}) could not complete web search right now.`;
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
	const searchResultByUrl = new Map<string, ProviderSearchResult>();
	for (const source of response.search_results || []) {
		if (source.url) searchResultByUrl.set(normalizedWebSourceUrl(source.url), source);
	}
	for (const [index, citation] of (response.citations || []).entries()) {
		const url = (typeof citation === 'string' ? citation : citation.url) || response.search_results?.[index]?.url;
		if (!url) continue;
		const matchingResult = searchResultByUrl.get(normalizedWebSourceUrl(url));
		const title = (typeof citation === 'string' ? '' : citation.title) || matchingResult?.title || url;
		const snippet = (typeof citation === 'string' ? '' : citation.snippet) || matchingResult?.snippet || '';
		const publishedAt =
			(typeof citation === 'string' ? null : citation.date || citation.last_updated) ||
			matchingResult?.date ||
			matchingResult?.last_updated ||
			null;
		citedSources.push(webSource(url, title, snippet, { citationNumber: index + 1, publishedAt }));
	}
	for (const source of response.search_results || []) {
		if (!source.url) continue;
		actionSources.push(
			webSource(source.url, source.title || source.url, source.snippet || '', {
				publishedAt: source.date || source.last_updated || null
			})
		);
	}
	for (const source of response.fetch_url_results || []) {
		if (!source.url) continue;
		actionSources.push(
			webSource(source.url, source.title || source.url, source.content || source.snippet || '', {
				publishedAt: source.date || source.last_updated || null
			})
		);
	}
	for (const item of response.output || []) {
		for (const source of item.search_results || []) {
			if (!source.url) continue;
			actionSources.push(
				webSource(source.url, source.title || source.url, source.snippet || '', {
					publishedAt: source.date || source.last_updated || null
				})
			);
		}
		for (const source of item.fetch_url_results || []) {
			if (!source.url) continue;
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
				actionSources.push(
					webSource(source.url, source.title || source.url, source.snippet || '', {
						publishedAt: source.date || source.last_updated || null
					})
				);
			}
			for (const source of content.fetch_url_results || []) {
				if (!source.url) continue;
				actionSources.push(
					webSource(source.url, source.title || source.url, source.content || source.snippet || '', {
						publishedAt: source.date || source.last_updated || null
					})
				);
			}
			for (const annotation of content.annotations || []) {
				if (annotation.type !== 'url_citation' || !annotation.url) continue;
				citedSources.push(
					webSource(
						annotation.url,
						annotation.title || annotation.url,
						extractAnnotationSnippet(outputText, annotation.start_index, annotation.end_index)
					)
				);
			}
		}
	}
	return uniqueWebSources([...citedSources, ...actionSources]);
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
	options: { publishedAt?: string | null; citationNumber?: number } = {}
): WebSourceCandidate {
	const sourceSummary = compactToolText(snippet, 220);
	const titleSummary = compactWebSourceTitle(title, url, 220);
	const summary = sourceSummary || titleSummary;
	return {
		source_name: sourceNameFromUrl(url),
		source_url: url,
		title,
		extracted_text: summary || titleSummary || 'Web search cited this source.',
		summary: summary || titleSummary || 'Web search cited this source; verify the source page directly before publication.',
		limitations: ['Provider web_search result; cite and verify source page before publication.'],
		confidence: 0.6,
		published_at: options.publishedAt || null,
		citation_number: options.citationNumber
	};
}

function normalizedWebSourceUrl(value: string): string {
	return value.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
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

function extractAnnotationSnippet(outputText: string, startIndex?: number, endIndex?: number): string {
	if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return '';
	const start = Math.max(0, Number(startIndex));
	const end = Math.min(outputText.length, Number(endIndex));
	const contextStart = Math.max(0, outputText.lastIndexOf('.', start - 1) + 1);
	const nextPeriod = outputText.indexOf('.', end);
	const contextEnd = nextPeriod >= 0 ? Math.min(outputText.length, nextPeriod + 1) : Math.min(outputText.length, end + 180);
	return compactToolText(outputText.slice(contextStart, contextEnd), 260);
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
