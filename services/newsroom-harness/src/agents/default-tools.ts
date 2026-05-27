import { generateFinalAnswer } from './answer.js';
import { isUsableEvidence, normalizeEvidence, normalizeToolEvidence, type EvidenceObject } from './evidence.js';
import { NEWSROOM_TOOL_NAMES } from './router.js';
import { evidenceOutputSchema, ToolRegistry, type NewsroomTool, type ToolRunContext, type ToolRunOutput } from './tools.js';
import { fetchSourceUrl, sourceFromText } from '../tools/sources.js';
import { extractUrls, firstUrl } from '../util/text.js';
import { assessSourceQuality } from '../util/source-quality.js';

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
const MAX_WEB_SEARCH_SOURCES = 8;

export function createDefaultToolRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	for (const tool of [
		configuredSourceMonitorTool(),
		sourceFeedFetcherTool(),
		missionResultReaderTool(),
		openAiWebSearchTool(),
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

function missionResultReaderTool(): NewsroomTool<{ latest?: boolean }> {
	return {
		name: NEWSROOM_TOOL_NAMES.missionResultReader,
		description: 'Read saved NewsCraft mission outputs from the harness repository.',
		when_to_use: 'Use when a user asks for the latest mission output, saved mission report, or previous stored report.',
		category: 'mission_result_reader',
		input_schema: {
			type: 'object',
			properties: { latest: { type: 'boolean' } }
		},
		output_schema: evidenceOutputSchema,
		async run(_input, context) {
			if (!context.repository) {
				return { status: 'unavailable', limitations: ['No harness repository is available to read mission output.'] };
			}
			const report = context.repository.listReports()[0];
			if (!report) return { status: 'unavailable', limitations: ['No saved mission outputs were found.'] };
			const reportPreview = compactSavedReport(report.markdown);
			return {
				status: 'ok',
				evidence: [
					normalizeEvidence({
						source_name: 'NewsCraft saved mission output',
						source_url: `newsroom://mission-output/${report.id}`,
						accessed_at: new Date().toISOString(),
						tool_used: NEWSROOM_TOOL_NAMES.missionResultReader,
						title: report.title,
						published_at: report.created_at,
						extracted_text: reportPreview,
						summary: compactToolText(reportPreview, 260),
						confidence: 0.85,
						limitations: ['Saved mission output was summarized before reuse to avoid recursive report expansion.'],
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
		description: 'Use OpenAI Responses API web_search for broad context and related coverage.',
		when_to_use: 'Use for broad discovery, related coverage, and what other outlets are reporting.',
		category: 'web_search_provider',
		input_schema: {
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query']
		},
		output_schema: evidenceOutputSchema,
		async run(input, context) {
			if (!context.openAiApiKey) {
				return {
					status: 'unavailable',
					limitations: ['OpenAI web_search is not configured because OPENAI_API_KEY is missing.']
				};
			}
			const response = await fetch('https://api.openai.com/v1/responses', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${context.openAiApiKey}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					model: context.config.web_search_model,
					reasoning: { effort: 'low' },
					tools: [{ type: 'web_search' }],
					tool_choice: 'auto',
					include: ['web_search_call.action.sources'],
					input: [
						'Search for source material relevant to this newsroom request.',
						'Summarize the freshest usable result first, with concrete dates or timestamps when available.',
						'Prefer primary or official sources and directly relevant local/reputable outlets.',
						'Avoid forums, social threads, old PDFs, and loosely related background unless the request asks for them.',
						'Keep the answer concise and newsroom-ready.',
						`Request: ${input.query}`
					].join('\n')
				}),
				signal: context.signal
			});
			const raw = await response.json().catch(() => ({}));
			if (!response.ok) {
				return {
					status: 'error',
					limitations: [`OpenAI web_search failed with HTTP ${response.status}: ${String(raw?.error?.message || response.statusText)}`],
					raw
				};
			}
			const outputText = extractOpenAiOutputText(raw);
			const evidence = normalizeToolEvidence(
				{ evidence: extractOpenAiWebSources(raw, outputText, input.query) },
				NEWSROOM_TOOL_NAMES.webSearch,
				{
					source_name: 'OpenAI web_search',
					accessed_at: new Date().toISOString(),
					confidence: 0.6,
					limitations: ['Broad web-search evidence; verify important claims against primary sources.'],
					source_kind: 'media_report'
				}
			);
			return evidence.length
				? { status: 'ok', evidence, answer: outputText, raw: { output_text: outputText } }
				: {
						status: 'unavailable',
						limitations: ['OpenAI web_search returned no cited sources.'],
						raw: { output_text: outputText }
					};
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
		description: 'Extract text from supplied source text or fetchable non-PDF documents; reports limitations for PDFs without a parser.',
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
			if (input.text?.trim()) {
				const source = sourceFromText(input.url || 'newsroom://provided-document', input.text, 'Provided source document');
				return {
					status: 'ok',
					evidence: [fetchedSourceToEvidence(source, NEWSROOM_TOOL_NAMES.pdfTextExtractor, ['Provided text, not independently fetched.'])]
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

async function fetchEvidenceUrls(
	urls: string[],
	toolUsed: string,
	context: ToolRunContext
): Promise<EvidenceObject[]> {
	const evidence: EvidenceObject[] = [];
	for (const url of urls) {
		try {
			const source = await fetchSourceUrl(url, sourceFetchSignal(context.signal));
			evidence.push(fetchedSourceToEvidence(source, toolUsed));
		} catch (err) {
			evidence.push(
				normalizeEvidence({
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
				})
			);
		}
	}
	return evidence;
}

function sourceFetchSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(20_000);
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
		published_at: null,
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

function extractOpenAiOutputText(raw: unknown): string {
	const response = raw as {
		output_text?: string;
		output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
	};
	if (typeof response.output_text === 'string') return response.output_text;
	return (
		response.output
			?.flatMap((item) => item.content || [])
			.map((content) => content.text || '')
			.join('\n')
			.trim() || ''
	);
}

function extractOpenAiWebSources(raw: unknown, outputText: string, query: string) {
	const sources: Array<{
		source_name: string;
		source_url: string;
		title: string;
		extracted_text: string;
		summary: string;
		limitations: string[];
		confidence: number;
	}> = [];
	const response = raw as {
		output?: Array<{
			type?: string;
			action?: { sources?: Array<{ url?: string; title?: string; source?: string }> };
			content?: Array<{
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
	for (const item of response.output || []) {
		for (const source of item.action?.sources || []) {
			if (!source.url) continue;
			if (!shouldKeepWebSource(source.url, query)) continue;
			sources.push(webSource(source.url, source.title || source.source || source.url));
		}
		for (const content of item.content || []) {
			for (const annotation of content.annotations || []) {
				if (annotation.type !== 'url_citation' || !annotation.url) continue;
				if (!shouldKeepWebSource(annotation.url, query)) continue;
				sources.push(
					webSource(
						annotation.url,
						annotation.title || annotation.url,
						extractAnnotationSnippet(outputText, annotation.start_index, annotation.end_index)
					)
				);
			}
		}
	}
	return sources.slice(0, MAX_WEB_SEARCH_SOURCES);
}

function webSource(url: string, title: string, snippet = '') {
	const sourceSummary = compactToolText(snippet, 220);
	const titleSummary = compactToolText(title, 220);
	const summary = sourceSummary || titleSummary;
	return {
		source_name: sourceNameFromUrl(url),
		source_url: url,
		title,
		extracted_text: summary || titleSummary || 'Web search cited this source.',
		summary: summary || titleSummary || 'Web search cited this source; verify the source page directly before publication.',
		limitations: ['OpenAI web_search result; cite and verify source page before publication.'],
		confidence: 0.6
	};
}

function shouldKeepWebSource(url: string, query: string): boolean {
	const normalizedQuery = query.toLowerCase();
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
		const path = parsed.pathname.toLowerCase();
		if (!/\b(reddit|forum|social|thread)\b/.test(normalizedQuery) && /(^|\.)reddit\.com$/.test(host)) return false;
		if (!/\b(pdf|document|filing|budget)\b/.test(normalizedQuery) && path.endsWith('.pdf')) return false;
		return true;
	} catch {
		return true;
	}
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
