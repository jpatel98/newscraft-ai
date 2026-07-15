#!/usr/bin/env node
/**
 * Golden-prompt eval runner for NewsCraft AI — M4.
 *
 * Two modes:
 *   fixture  — No API key required. Uses a stubbed harness (no real HTTP) to
 *              verify routing, plan events, no-leak invariants, and latency
 *              envelope shape. Safe for CI. NEWSROOM_EVAL_MODE=fixture (default
 *              when no selected provider key is configured).
 *
 *   full     — Requires the selected provider key (PERPLEXITY_API_KEY or
 *              OPENAI_API_KEY). Runs against a live harness and records real
 *              latency, citation presence, and answer quality. Also runs
 *              router-fallback vs planner side-by-side when
 *              NEWSROOM_EVAL_COMPARE_PLANNER is set.
 *
 * Usage:
 *   node services/newsroom-harness/eval/run-eval.mjs
 *   NEWSROOM_EVAL_MODE=full node services/newsroom-harness/eval/run-eval.mjs
 *   NEWSROOM_EVAL_MODE=full NEWSROOM_EVAL_COMPARE_PLANNER=1 node ...
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');
const harnessRoot = path.resolve(__dirname, '..');

loadEnv({ path: path.join(harnessRoot, '.env.local'), override: false, quiet: true });
loadEnv({ path: path.join(harnessRoot, '.env'), override: false, quiet: true });
loadEnv({ path: path.join(root, '.env.local'), override: false, quiet: true });
loadEnv({ path: path.join(root, '.env'), override: false, quiet: true });

// ─── Config ────────────────────────────────────────────────────────────────────

const providerResolution = resolveModelProvider({
  requested: providerFromEnv(process.env.NEWSROOM_MODEL_PROVIDER),
  openAiApiKey: process.env.OPENAI_API_KEY,
  perplexityApiKey: process.env.PERPLEXITY_API_KEY
});
const mode = process.env.NEWSROOM_EVAL_MODE || (providerResolution.configured ? 'full' : 'fixture');
const comparePlanner = process.env.NEWSROOM_EVAL_COMPARE_PLANNER === '1';
const harnessUrl = process.env.NEWSROOM_HARNESS_URL || 'http://127.0.0.1:8650';
const harnessApiKey = process.env.NEWSROOM_HARNESS_API_KEY || process.env.AGENT_GATEWAY_API_KEY || '';
const promptFilter = process.env.NEWSROOM_EVAL_PROMPT_ID || null; // run only one prompt id
const EXPECTED_PROMPT_COUNT = 24;
const LIVE_MIN_PASS_COUNT = 21;
const ORIGINAL_PROMPT_IDS = [
  'current-events-canada',
  'current-events-today-phrasing',
  'current-events-regional',
  'claim-verification-official-source',
  'claim-verification-no-evidence',
  'competitor-coverage-comparison',
  'competitor-coverage-named-outlet',
  'followup-with-context',
  'followup-ambiguous',
  'paywalled-source',
  'simple-answer-from-memory',
  'newsroom-brief-generation',
  'current-events-ongoing-story',
  'claim-verification-primary-source-policy',
  'current-events-no-evidence-obscure'
];

/** Latency budgets in ms. In fixture mode we use generous bounds (no real I/O). */
const BUDGETS = {
  /** simple_answer: ≤8s real, ≤20s fixture */
  simple:  { ttft: mode === 'fixture' ? 20_000 : 8_000,  total: mode === 'fixture' ? 20_000 : 8_000 },
  /** research: p50 ≤30s / p90 ≤60s real; ≤120s fixture (spawns no network) */
  research: { ttft: mode === 'fixture' ? 120_000 : 30_000, total: mode === 'fixture' ? 120_000 : 60_000 }
};

function providerFromEnv(value) {
  return value === 'openai' || value === 'perplexity' ? value : undefined;
}

function providerLabel(provider) {
  return provider === 'openai' ? 'OpenAI' : 'Perplexity';
}

function providerKeyName(provider) {
  return provider === 'openai' ? 'OPENAI_API_KEY' : 'PERPLEXITY_API_KEY';
}

function resolveModelProvider({ requested, openAiApiKey, perplexityApiKey }) {
  const openAiEnabled = Boolean(openAiApiKey);
  const perplexityEnabled = Boolean(perplexityApiKey);

  if (requested) {
    return {
      provider: requested,
      configured: requested === 'openai' ? openAiEnabled : perplexityEnabled,
      selection: 'explicit',
      reason: `${providerLabel(requested)} was explicitly selected via NEWSROOM_MODEL_PROVIDER.`
    };
  }

  if (openAiEnabled) {
    return {
      provider: 'openai',
      configured: true,
      selection: 'fallback',
      reason: 'Using OpenAI by default because OPENAI_API_KEY is available.'
    };
  }

  if (perplexityEnabled) {
    return {
      provider: 'perplexity',
      configured: true,
      selection: 'fallback',
      reason: 'Falling back to Perplexity because OPENAI_API_KEY is not configured.'
    };
  }

  return {
    provider: 'openai',
    configured: false,
    selection: 'disabled',
    reason: 'No provider keys are configured.'
  };
}

// ─── Tool-name / adapter-name leak detection ──────────────────────────────────

/** Internal tool identifiers and adapter names that must never appear in answers. */
const LEAKED_INTERNAL_TERMS = [
  'openai',
  'perplexity',
  'sonar',
  'openai_web_search',
  'configured_source_monitor',
  'source_feed_fetcher',
  'saved_research_reader',
  'url_fetch_read',
  'browser_automation_provider',
  'pdf_text_extractor',
  'newsroom_brief_generator',
  'assignment_desk',
  // adapter names
  'rss_adapter',
  'atom_adapter',
  'html_adapter',
  'bluesky_adapter',
  'sitemap_adapter',
  'pdf_adapter',
  // IDs / internal fields
  'run_id',
  'job_id',
  'source_kind',
  'tool_used',
  'agent.source',
  'agent.citations',
  'harness',
  'sqlite',
  'fixture mode',
  'fixture-cbc',
  'fixture-ctv',
  'fixture-global'
];

const LEAKED_INTERNAL_PATTERNS = [
  { label: 'raw HTTP error', pattern: /\bHTTP\s+[45]\d{2}\b/i },
  { label: 'raw JSON error', pattern: /["'](?:error|error_type|status_code)["']\s*:/i },
  { label: 'provider API', pattern: /\b(?:responses|chat completions?) API\b/i }
];

function detectLeaks(text) {
  const lower = text.toLowerCase();
  return [
    ...LEAKED_INTERNAL_TERMS.filter((term) => lower.includes(term.toLowerCase())),
    ...LEAKED_INTERNAL_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label)
  ];
}

// ─── Fixture mode harness — no real API calls ─────────────────────────────────

/**
 * Build a stub run result that matches the shape of a real harness response but
 * uses canned evidence. Deterministic, fast, zero API calls.
 */
function fixtureRunResult(promptEntry) {
  const { checks, class: promptClass, id } = promptEntry;
  const isAmbiguous = id === 'followup-ambiguous';
  const isObscure = id === 'current-events-no-evidence-obscure';
  const isNoEvidence = id === 'claim-verification-no-evidence';
  const isPaywalled = id === 'paywalled-source';
  const hasDocuments = Array.isArray(promptEntry.documents) && promptEntry.documents.length > 0;
  const usesBroadSearch =
    promptClass === 'current_events' ||
    promptClass === 'claim_verification' ||
    promptClass === 'competitor_coverage' ||
    checks.requires_external_corroboration === true;

  // Plan steps (fixture)
  const steps = [];
  if (!isAmbiguous && checks.requires_plan_events) {
    if (checks.requires_direct_url_retrieval) {
      steps.push({ id: 'step-1', tool: 'url_fetch_read', label: 'Reading the provided page', status: 'ok' });
    } else if (hasDocuments) {
      steps.push({ id: 'step-1', tool: 'pdf_text_extractor', label: 'Reading attached documents', status: 'ok' });
      if (checks.requires_external_corroboration) {
        steps.push({ id: 'step-2', tool: 'openai_web_search', label: 'Checking official sources', status: 'ok' });
      }
    } else if (usesBroadSearch) {
      steps.push({ id: 'step-1', tool: 'openai_web_search', label: 'Searching recent coverage', status: 'ok' });
    } else {
      steps.push({ id: 'step-1', tool: 'configured_source_monitor', label: 'Checking supplied context', status: 'ok' });
    }
  }

  // Evidence / citations
  let citations = [];
  if (id === 'citation-integrity-more-than-eight') {
    citations = Array.from({ length: 12 }, (_, index) =>
      fixtureCitation(index + 1, {
        url: `https://www.canada.ca/en/public-policy/news/2026/07/announcement-${index + 1}.html`,
        title: `Government announcement ${index + 1}`,
        sourceType: 'official',
        publicationDate: '2026-07-10',
        supportingExcerpt: `Official announcement ${index + 1} was published today.`
      })
    );
  } else if (id === 'fifa-schedule-official-evidence') {
    citations = [
      fixtureCitation(1, {
        url: 'https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures',
        title: 'FIFA World Cup 2026 scores and fixtures',
        sourceType: 'primary',
        publicationDate: '2026-07-10',
        supportingExcerpt: 'The official match centre lists the matches scheduled for July 10.'
      })
    ];
  } else if (id === 'conflicting-reports-disagreement') {
    citations = [
      fixtureCitation(1, {
        url: 'https://www.cbc.ca/news/canada/toronto/transit-shutdown-update',
        title: 'Transit shutdown expected to end Friday',
        sourceType: 'news_report',
        publicationDate: '2026-07-10',
        supportingExcerpt: 'The report says service could resume Friday morning.'
      }),
      fixtureCitation(2, {
        url: 'https://www.ttc.ca/news/2026/July/service-update',
        title: 'TTC service update',
        sourceType: 'official',
        publicationDate: '2026-07-10',
        supportingExcerpt: 'The operator says no reopening time has been confirmed.'
      })
    ];
  } else if (id === 'user-pdf-page-citations' || id === 'document-only-summary') {
    const filename = id === 'user-pdf-page-citations' ? 'council-report.pdf' : 'municipal-audit.pdf';
    const pages = id === 'user-pdf-page-citations' ? [2, 7] : [1, 3];
    citations = pages.map((page, index) =>
      fixtureCitation(index + 1, {
        url: `/api/conversations/eval/documents/${promptEntry.documents[0].id}/download`,
        title: `${filename}, page ${page}`,
        domain: 'Attached document',
        publicationDate: null,
        sourceType: 'user_document',
        documentPage: page,
        supportingExcerpt: promptEntry.documents[0].pages[index].text
      })
    );
  } else if (id === 'pasted-url-direct-retrieval') {
    citations = [
      fixtureCitation(1, {
        url: promptEntry.expected_url,
        title: 'Bank of Canada maintains policy rate',
        sourceType: 'official',
        publicationDate: '2024-01-24',
        supportingExcerpt: 'The Bank held the target for the overnight rate at 5 percent.'
      })
    ];
  } else if (id === 'document-explicit-corroboration') {
    citations = [
      fixtureCitation(1, {
        url: `/api/conversations/eval/documents/${promptEntry.documents[0].id}/download`,
        title: 'transit-memo.pdf, page 2',
        domain: 'Attached document',
        publicationDate: null,
        sourceType: 'user_document',
        documentPage: 2,
        supportingExcerpt: promptEntry.documents[0].pages[0].text
      }),
      fixtureCitation(2, {
        url: 'https://www.ttc.ca/service-advisories/subway-service',
        title: 'TTC subway service advisories',
        sourceType: 'official',
        publicationDate: '2026-07-09',
        supportingExcerpt: 'The official advisory does not announce an 11 p.m. system-wide closing time.'
      })
    ];
  } else if (id === 'unknown-publication-date') {
    citations = [
      fixtureCitation(1, {
        url: 'https://www.portauthority.example/public-notices/harbour-closure',
        title: 'Harbour closure public notice',
        sourceType: 'official',
        publicationDate: null,
        supportingExcerpt: 'The notice says the east channel is closed until further notice.'
      })
    ];
  } else if (
    (id === 'claim-verification-official-source' || id === 'claim-verification-primary-source-policy') &&
    !isNoEvidence
  ) {
    const isBank = id === 'claim-verification-official-source';
    citations = [
      fixtureCitation(1, {
        url: isBank ? 'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/' : 'https://www.rcmp-grc.gc.ca/en/news',
        title: isBank ? 'Bank of Canada policy interest rate' : 'RCMP official statement',
        sourceType: 'official',
        publicationDate: '2026-07-09',
        supportingExcerpt: 'The official source provides the confirmed public statement.'
      })
    ];
  } else if (usesBroadSearch && !isAmbiguous && !isObscure && !isNoEvidence && !isPaywalled) {
    citations = [
      fixtureCitation(1, {
        url: 'https://www.cbc.ca/news/politics/current-update',
        title: 'CBC News current update',
        sourceType: 'news_report',
        publicationDate: '2026-07-10',
        supportingExcerpt: 'Recent reporting describes active developments on this topic.'
      })
    ];
  }

  // Answer text
  let answerText;
  if (isAmbiguous) {
    answerText = 'Could you clarify which statement you are referring to? I don\'t have context from our recent conversation about what "they" said or "it" refers to.';
  } else if (isObscure || isNoEvidence) {
    answerText = 'I was unable to find specific coverage of this topic. No official or primary evidence was found, so the claim remains unverified. Please verify directly with local sources before publishing.';
  } else if (isPaywalled) {
    answerText = 'The linked Globe and Mail page appears to be behind a paywall or is unavailable. I could not extract content from this source. Please obtain access directly before publication.';
  } else if (id === 'citation-integrity-more-than-eight') {
    answerText = `Twelve announcements were identified: ${citations.map((citation) => `item ${citation.citationNumber} [${citation.citationNumber}]`).join('; ')}.`;
  } else if (id === 'fifa-schedule-official-evidence') {
    answerText = 'Current as of 2:00 p.m. EDT on July 10, 2026: FIFA\'s official match centre lists today\'s fixtures and kickoff times [1].';
  } else if (id === 'conflicting-reports-disagreement') {
    answerText = 'CBC reports that service could resume Friday morning [1]. The TTC says no reopening time is confirmed [2]. The accounts disagree on timing; only the continued shutdown is confirmed.';
  } else if (id === 'user-pdf-page-citations') {
    answerText = 'The report proposes a $4.2 million transit-service increase [1] and defers the arena renovation by one year [2].';
  } else if (id === 'pasted-url-direct-retrieval') {
    answerText = 'The Bank of Canada held its policy rate at 5 percent and continued quantitative tightening [1].';
  } else if (id === 'document-only-summary') {
    answerText = '- Procurement documentation was incomplete in 14 of 40 sampled contracts [1].\n- Quarterly compliance reviews are planned beginning in September [2].';
  } else if (id === 'document-explicit-corroboration') {
    answerText = 'The memo claims subway service will end at 11 p.m. [1]. The official advisory does not confirm that change [2], so the memo\'s system-wide claim remains unverified.';
  } else if (id === 'inherited-provenance-transformation') {
    answerText = '**Producer brief:** The Bank held its policy rate at 5 percent [1].';
  } else if (id === 'unknown-publication-date') {
    answerText = 'The public notice says the east channel is closed until further notice [1]. Publication date: Date unknown.';
  } else if (id === 'current-events-today-phrasing') {
    answerText = 'Current as of 2:00 p.m. EDT on July 10, 2026: Recent reporting describes today\'s leading stories [1].';
  } else if (id === 'claim-verification-official-source') {
    answerText = 'The Bank of Canada\'s official page confirms the current policy rate [1]. Any claim beyond that release remains unverified.';
  } else if (id === 'claim-verification-primary-source-policy') {
    answerText = 'The RCMP\'s official statement confirms the publicly released details [1]. Other reported details remain unverified.';
  } else if (id === 'followup-with-context') {
    answerText = 'The supplied context says police confirmed that one victim was transported to hospital.';
  } else if (promptClass === 'simple_answer') {
    answerText =
      id === 'newsroom-brief-generation'
        ? 'Toronto city council approved the 2026 operating budget 20-5 after a six-hour debate. The mayor called the decision tough but necessary.'
        : 'A nut graf (also called nutshell paragraph) is a brief explanatory paragraph in a news story that summarizes the broader significance of the story for the reader.';
  } else {
    answerText = citations.length
      ? 'Recent reporting describes active developments on this topic [1]. Verify material claims with direct sources before publishing.'
      : 'Here is a concise summary based on the supplied context.';
  }

  return {
    answer: answerText,
    plan: { source: steps.length > 0 ? 'model' : 'router', steps },
    citations,
    inheritedCitations: promptEntry.prior_citations ?? [],
    ttft_ms: steps.length > 0 ? 180 : 50,  // deterministic fixture timing
    total_ms: steps.length > 0 ? 400 : 80
  };
}

function fixtureCitation(citationNumber, options) {
  return {
    citationNumber,
    title: options.title,
    url: options.url,
    domain: options.domain ?? domainFromUrl(options.url),
    publicationDate: options.publicationDate ?? null,
    sourceType: options.sourceType,
    supportingExcerpt: options.supportingExcerpt,
    ...(options.documentPage ? { documentPage: options.documentPage } : {}),
    fetchedAt: '2026-07-10T18:00:00.000Z'
  };
}

// ─── Full-mode harness call ────────────────────────────────────────────────────

/**
 * Execute a chat stream against the running harness and collect:
 *  - answer text (all delta chunks joined)
 *  - time-to-first-token (ms)
 *  - total time (ms)
 *  - plan events (agent.plan SSE frames)
 *  - structured citations (agent.citations, with agent.source fallback)
 */
async function fullRunAgainstHarness(promptEntry, plannerEnabled) {
  const { prompt, prior_context: priorContext, prior_answer: priorAnswer } = promptEntry;
  const messages = [];
  if (priorContext) {
    messages.push({ role: 'user', content: priorContext });
    messages.push({ role: 'assistant', content: priorAnswer || 'Understood. I have that context.' });
  }
  messages.push({ role: 'user', content: prompt });

  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(harnessApiKey ? { authorization: `Bearer ${harnessApiKey}` } : {})
  };

  const body = JSON.stringify({
    messages,
    stream: true,
    ...(promptEntry.newsroom_context ? { newsroom_context: promptEntry.newsroom_context } : {}),
    ...(promptEntry.documents ? { documents: promptEntry.documents } : {}),
    ...(typeof plannerEnabled === 'boolean' ? { planner_enabled: plannerEnabled } : {})
  });
  const startMs = Date.now();
  let ttftMs = null;

  const response = await fetch(`${harnessUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(90_000)
  });

  if (!response.ok || !response.body) {
    throw new Error(`harness /v1/chat/completions responded ${response.status}: ${await response.text()}`);
  }

  const answerChunks = [];
  const planEvents = [];
  const sources = [];
  const structuredCitations = [];

  for await (const event of readSse(response.body)) {
    if (event.event === 'message') {
      if (event.data === '[DONE]') break;
      const payload = safeJson(event.data);
      const delta = payload?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        if (ttftMs === null) ttftMs = Date.now() - startMs;
        answerChunks.push(delta);
      }
    } else if (event.event === 'agent.plan') {
      const payload = safeJson(event.data);
      if (payload) planEvents.push(payload);
    } else if (event.event === 'agent.source') {
      const payload = safeJson(event.data);
      if (payload) sources.push(payload);
    } else if (event.event === 'agent.citations') {
      const payload = safeJson(event.data);
      if (Array.isArray(payload?.citations)) structuredCitations.push(...payload.citations);
    }
  }

  const totalMs = Date.now() - startMs;
  const answer = answerChunks.join('');
  return {
    answer,
    plan: planEvents.at(-1) || null,
    citations:
      structuredCitations.length > 0
        ? structuredCitations
        : sources
            .filter((source) => source?.status !== 'skipped')
            .map((source, index) => legacyCitationFromSource(source, index + 1)),
    inheritedCitations: promptEntry.prior_citations ?? [],
    legacySourceCount: sources.length,
    ttft_ms: ttftMs ?? totalMs,
    total_ms: totalMs
  };
}

function legacyCitationFromSource(source, citationNumber) {
  const url = typeof source?.url === 'string' ? source.url : '';
  return {
    citationNumber,
    title: typeof source?.title === 'string' && source.title.trim() ? source.title : url || 'Source',
    url,
    domain: domainFromUrl(url),
    publicationDate: null,
    sourceType: 'unknown',
    supportingExcerpt: typeof source?.detail === 'string' ? source.detail : ''
  };
}

// ─── Check evaluation ─────────────────────────────────────────────────────────

function normalizeCitationRecords(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((record) => record && typeof record === 'object')
    .map((record, index) => ({
      citationNumber: positiveInteger(record.citationNumber ?? record.citation_number ?? record.number),
      title: stringValue(record.title),
      url: stringValue(record.url),
      domain: stringValue(record.domain) || domainFromUrl(stringValue(record.url)),
      publicationDate: nullableString(record.publicationDate ?? record.publication_date ?? record.publishedAt),
      sourceType: normalizeSourceType(record.sourceType ?? record.source_type ?? record.source_kind),
      supportingExcerpt: stringValue(record.supportingExcerpt ?? record.supporting_excerpt ?? record.detail),
      documentPage: positiveInteger(record.documentPage ?? record.document_page ?? record.page),
      fetchedAt: nullableString(record.fetchedAt ?? record.fetched_at ?? record.accessedAt ?? record.accessed_at),
      arrivalIndex: index
    }));
}

function effectiveCitationRecords(run) {
  const combined = [
    ...normalizeCitationRecords(run.citations),
    ...normalizeCitationRecords(run.inheritedCitations)
  ];
  const seen = new Set();
  return combined.filter((citation) => {
    const key = `${citation.citationNumber ?? 'invalid'}\n${normalizeUrl(citation.url)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function citationMarkers(answer) {
  return Array.from(answer.matchAll(/\[(\d+)\](?!:)/g), (match) => Number(match[1]));
}

function citationIntegrity(answer, citations) {
  const markers = citationMarkers(answer);
  const recordsByNumber = new Map();
  for (const citation of citations) {
    if (!citation.citationNumber) continue;
    const records = recordsByNumber.get(citation.citationNumber) ?? [];
    records.push(citation);
    recordsByNumber.set(citation.citationNumber, records);
  }
  const danglingMarkers = markers.filter((number) => (recordsByNumber.get(number)?.length ?? 0) !== 1);
  const duplicateNumbers = Array.from(recordsByNumber.entries())
    .filter(([, records]) => records.length > 1)
    .map(([number]) => number);
  return {
    markers,
    resolvedCount: markers.length - danglingMarkers.length,
    danglingMarkers,
    duplicateNumbers
  };
}

function planSteps(run) {
  return Array.isArray(run.plan?.steps) ? run.plan.steps : [];
}

function stepDescriptor(step) {
  return [step?.tool, step?.name, step?.label, step?.detail].filter((value) => typeof value === 'string').join(' ').toLowerCase();
}

function planUsesExternalSearch(run) {
  return planSteps(run).some((step) => /web[_ ]search|searching (?:recent|official|the web)|broad search|source feed/.test(stepDescriptor(step)));
}

function planReadsProvidedUrl(run) {
  return planSteps(run).findIndex((step) => /url[_ ]fetch|provided (?:page|url)|direct (?:page|url)/.test(stepDescriptor(step)));
}

function domainFromUrl(value) {
  if (value.startsWith('/api/')) return 'Attached document';
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return 'Unknown source';
  }
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '') || '/';
    return url.toString().toLowerCase();
  } catch {
    return value.replace(/\/$/, '').toLowerCase();
  }
}

function normalizeSourceType(value) {
  if (value === 'media_report') return 'news_report';
  return ['official', 'primary', 'news_report', 'social_post', 'user_document', 'commercial', 'unknown'].includes(value)
    ? value
    : 'unknown';
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableString(value) {
  const normalized = stringValue(value);
  return normalized || null;
}

function evalResult(promptEntry, run, budget) {
  const { checks } = promptEntry;
  const results = [];
  const citations = effectiveCitationRecords(run);
  const currentCitations = normalizeCitationRecords(run.citations);
  const inheritedCitations = normalizeCitationRecords(run.inheritedCitations);
  const integrity = citationIntegrity(run.answer, citations);

  results.push({ name: 'ttft_budget', pass: run.ttft_ms <= budget.ttft, detail: `ttft=${run.ttft_ms}ms budget=${budget.ttft}ms` });
  results.push({ name: 'total_budget', pass: run.total_ms <= budget.total, detail: `total=${run.total_ms}ms budget=${budget.total}ms` });
  results.push({
    name: 'zero_dangling_citations',
    pass: integrity.danglingMarkers.length === 0 && integrity.duplicateNumbers.length === 0,
    detail:
      integrity.danglingMarkers.length === 0 && integrity.duplicateNumbers.length === 0
        ? `${integrity.resolvedCount}/${integrity.markers.length} marker(s) resolved`
        : `dangling=[${integrity.danglingMarkers.join(', ')}] duplicate_numbers=[${integrity.duplicateNumbers.join(', ')}]`
  });

  // Plan events
  if (checks.requires_plan_events) {
    const hasPlan = run.plan !== null && Array.isArray(run.plan?.steps) && run.plan.steps.length > 0;
    results.push({
      name: 'plan_events_present',
      pass: hasPlan,
      detail: hasPlan ? `${run.plan.steps.length} steps from ${run.plan.source}` : 'no plan steps emitted'
    });
  }

  // Citation presence on current-events prompts
  if (checks.requires_citation) {
    const citationCount = citations.length;
    const answerHasLinks = /\bhttps?:\/\/\S+/i.test(run.answer) || /\[.+?\]\(.+?\)/i.test(run.answer);
    const hasCitation = citationCount > 0 || answerHasLinks;
    results.push({
      name: 'citation_present',
      pass: hasCitation,
      detail: hasCitation ? `${citationCount} citation record(s)` : 'no citations found'
    });
  }

  if (checks.minimum_citations) {
    results.push({
      name: 'minimum_citation_count',
      pass: citations.length >= checks.minimum_citations,
      detail: `${citations.length} record(s); minimum=${checks.minimum_citations}`
    });
  }

  if (checks.requires_citation_order) {
    const citationNumbers = citations.map((citation) => citation.citationNumber);
    const markerOrder = Array.from(new Set(integrity.markers));
    const contiguous = citationNumbers.every((number, index) => number === index + 1);
    const sameOrder = citationNumbers.length === markerOrder.length && citationNumbers.every((number, index) => number === markerOrder[index]);
    results.push({
      name: 'citation_order_preserved',
      pass: contiguous && sameOrder,
      detail: `records=[${citationNumbers.join(', ')}] markers=[${markerOrder.join(', ')}]`
    });
  }

  if (checks.requires_all_citations_referenced) {
    const markerSet = new Set(integrity.markers);
    const unreferenced = citations
      .filter((citation) => !citation.citationNumber || !markerSet.has(citation.citationNumber))
      .map((citation) => citation.citationNumber ?? 'invalid');
    results.push({
      name: 'all_citations_referenced',
      pass: unreferenced.length === 0,
      detail: unreferenced.length === 0 ? 'all records referenced' : `unreferenced=[${unreferenced.join(', ')}]`
    });
  }

  // No leaked tool names / adapter names / internal IDs in answer
  if (checks.must_not_leak_tool_names || checks.must_not_leak_adapter_names || checks.must_not_leak_ids) {
    const leaked = detectLeaks(run.answer);
    results.push({
      name: 'no_internal_leakage',
      pass: leaked.length === 0,
      detail: leaked.length === 0 ? 'clean' : `leaked: ${leaked.join(', ')}`
    });
  }

  // Caveat on no-evidence answers
  if (checks.requires_caveat_on_no_evidence) {
    const hasCaveat = [
      /\b(could not|couldn't|unable to|cannot (confirm|verify|find|locate|access)|can't (confirm|verify|find|locate|access))\b/i,
      /\bno (specific|confirmed|available|reliable sources?|evidence|official minutes?|confirmed details?)\b/i,
      /\bnot (yet )?(available|published|confirmed|verified|documented|found)\b/i,
      /\bwithout (official|first-party|primary)\b/i,
      /\b(unverified|before publishing|paywall|blocked|caveat)\b/i
    ].some((pattern) => pattern.test(run.answer));
    results.push({
      name: 'caveat_on_no_evidence',
      pass: hasCaveat,
      detail: hasCaveat ? 'caveat present' : 'no caveat found for potential no-evidence answer'
    });
  }

  if (checks.requires_primary_evidence_or_caveat) {
    const primaryCount = citations.filter((citation) => citation.sourceType === 'official' || citation.sourceType === 'primary').length;
    const explicitlyAbsent = /\bno (?:official(?: or primary)?|primary|first-party) (?:sources?|evidence) (?:was |were |could be )?(?:found|available|located|published)\b/i.test(
      run.answer
    );
    results.push({
      name: 'primary_evidence_or_explicit_absence',
      pass: primaryCount > 0 || explicitlyAbsent,
      detail: primaryCount > 0 ? `${primaryCount} primary/official record(s)` : explicitlyAbsent ? 'explicit absence stated' : 'no primary evidence or explicit absence statement'
    });
  }

  if (checks.requires_publication_date) {
    const invalid = citations.filter((citation) => {
      if (!citation.publicationDate || Number.isNaN(Date.parse(citation.publicationDate))) return true;
      return Boolean(citation.fetchedAt && citation.publicationDate === citation.fetchedAt);
    });
    results.push({
      name: 'publication_date_preserved',
      pass: citations.length > 0 && invalid.length === 0,
      detail: invalid.length === 0 && citations.length > 0 ? `${citations.length} publication date(s) retained` : `${invalid.length || citations.length} missing, invalid, or fetch-time date(s)`
    });
  }

  if (checks.requires_current_as_of) {
    const labelled = /\bcurrent as of\b/i.test(run.answer);
    results.push({
      name: 'current_as_of_label',
      pass: labelled,
      detail: labelled ? 'local current-as-of label present' : 'missing current-as-of label'
    });
  }

  if (checks.requires_disagreement) {
    const surfaced = /\b(conflict(?:ing)?|disagree|differ|accounts? (?:do not|don't) match|not confirmed|remains? unresolved)\b/i.test(run.answer);
    results.push({
      name: 'disagreement_surfaced',
      pass: surfaced,
      detail: surfaced ? 'disagreement explicit' : 'conflicting claims were not identified'
    });
  }

  if (checks.requires_document_page_citations) {
    const documentCitations = citations.filter((citation) => citation.sourceType === 'user_document');
    const markers = new Set(integrity.markers);
    const valid =
      documentCitations.length > 0 &&
      documentCitations.every((citation) => citation.documentPage && citation.citationNumber && markers.has(citation.citationNumber));
    results.push({
      name: 'document_page_citations',
      pass: valid,
      detail: valid ? `${documentCitations.length} filename/page citation(s)` : 'document citations are missing filename/page resolution'
    });
  }

  if (checks.forbids_external_search) {
    const searched = planUsesExternalSearch(run);
    results.push({
      name: 'no_unrequested_external_search',
      pass: !searched,
      detail: searched ? 'external search step observed' : 'no external search step observed'
    });
  }

  if (checks.requires_only_document_evidence) {
    const documentOnly = currentCitations.length > 0 && currentCitations.every((citation) => citation.sourceType === 'user_document');
    results.push({
      name: 'document_only_evidence',
      pass: documentOnly,
      detail: documentOnly ? `${currentCitations.length} document record(s)` : 'non-document evidence was introduced'
    });
  }

  if (checks.requires_direct_url_retrieval) {
    const directStepIndex = planReadsProvidedUrl(run);
    const searchStepIndex = planSteps(run).findIndex((step) => /web[_ ]search|broad search/.test(stepDescriptor(step)));
    const expectedUrl = normalizeUrl(promptEntry.expected_url || '');
    const citedExpectedUrl = citations.some((citation) => normalizeUrl(citation.url) === expectedUrl);
    const directFirst = directStepIndex >= 0 && (searchStepIndex < 0 || directStepIndex < searchStepIndex);
    results.push({
      name: 'direct_url_retrieval_first',
      pass: citedExpectedUrl && directFirst,
      detail: `expected_url_cited=${citedExpectedUrl} direct_step=${directStepIndex} search_step=${searchStepIndex}`
    });
  }

  if (checks.requires_external_corroboration) {
    const hasDocument = currentCitations.some((citation) => citation.sourceType === 'user_document');
    const hasExternal = currentCitations.some((citation) => citation.sourceType !== 'user_document');
    const searched = planUsesExternalSearch(run);
    results.push({
      name: 'explicit_external_corroboration',
      pass: hasDocument && hasExternal && searched,
      detail: `document=${hasDocument} external=${hasExternal} search=${searched}`
    });
  }

  if (checks.requires_inherited_provenance) {
    const answerMarkers = new Set(integrity.markers);
    const preserved =
      inheritedCitations.length > 0 &&
      inheritedCitations.every(
        (citation) =>
          (citation.citationNumber && answerMarkers.has(citation.citationNumber)) ||
          (citation.url && run.answer.includes(citation.url))
      );
    results.push({
      name: 'inherited_provenance_preserved',
      pass: preserved,
      detail: preserved ? `${inheritedCitations.length} inherited citation(s) retained` : 'previous citation markers or links were dropped'
    });
  }

  if (checks.requires_unknown_publication_date_label) {
    const hasUnknownDate = citations.some((citation) => citation.publicationDate === null);
    const labelledUnknown = /\bdate unknown\b/i.test(run.answer);
    results.push({
      name: 'unknown_publication_date_labelled',
      pass: hasUnknownDate && labelledUnknown,
      detail: `unknown_record=${hasUnknownDate} labelled=${labelledUnknown}`
    });
  }

  // Clarification request for ambiguous follow-up
  if (checks.must_request_clarification) {
    const asksClarification = /\b(clarif|which|what (are you|do you mean)|could you|can you specify|context)\b/i.test(run.answer);
    results.push({
      name: 'requests_clarification',
      pass: asksClarification,
      detail: asksClarification ? 'clarification requested' : 'no clarification request found'
    });
  }

  // Paywall / blocked flag
  if (checks.must_flag_paywall_or_blocked) {
    const flagged = /\b(paywall|blocked|unavailable|could not (access|read|fetch)|login|subscription|access denied)\b/i.test(run.answer);
    results.push({
      name: 'paywall_flagged',
      pass: flagged,
      detail: flagged ? 'paywall/block flagged' : 'no paywall or block flag found'
    });
  }

  const passed = results.every((result) => result.pass);
  return {
    passed,
    checks: results,
    citationMetrics: {
      markerCount: integrity.markers.length,
      resolvedCount: integrity.resolvedCount,
      danglingCount: integrity.danglingMarkers.length,
      duplicateNumberCount: integrity.duplicateNumbers.length,
      primarySourceCount: citations.filter((citation) => citation.sourceType === 'official' || citation.sourceType === 'primary').length,
      unknownDateCount: citations.filter((citation) => citation.publicationDate === null).length
    }
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function validatePromptSuite(prompts) {
  if (!Array.isArray(prompts)) throw new Error('Golden prompts must be a JSON array.');
  if (prompts.length !== EXPECTED_PROMPT_COUNT) {
    throw new Error(`Golden suite must contain ${EXPECTED_PROMPT_COUNT} prompts; found ${prompts.length}.`);
  }
  const ids = prompts.map((prompt) => prompt?.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error('Golden suite prompt IDs must be unique.');
  const missingOriginalIds = ORIGINAL_PROMPT_IDS.filter((id) => !ids.includes(id));
  if (missingOriginalIds.length > 0) {
    throw new Error(`Golden suite dropped original prompts: ${missingOriginalIds.join(', ')}`);
  }
}

async function main() {
  const promptsPath = path.join(__dirname, 'golden-prompts.json');
  const prompts = JSON.parse(await readFile(promptsPath, 'utf8'));
  validatePromptSuite(prompts);

  const filtered = promptFilter ? prompts.filter((p) => p.id === promptFilter) : prompts;
  if (filtered.length === 0) {
    console.error(`No prompts matched filter: ${promptFilter}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nNewsCraft AI — Golden-prompt eval suite`);
  console.log(`Mode: ${mode}${comparePlanner ? ' + planner comparison' : ''}`);
  console.log(
    `Provider: ${providerResolution.provider} (${providerResolution.configured ? 'configured' : 'not configured'}; ${providerResolution.selection})`
  );
  console.log(`Prompts: ${filtered.length} of ${prompts.length}`);
  console.log('─'.repeat(60));

  if (mode === 'full') {
    if (!providerResolution.configured) {
      console.error(
        `Full-mode eval requires ${providerKeyName(providerResolution.provider)} for selected provider ${providerResolution.provider}.`
      );
      console.error(providerResolution.reason);
      console.error('Set the selected provider key or use NEWSROOM_EVAL_MODE=fixture.');
      process.exitCode = 1;
      return;
    }
    // Warm-up check — confirm harness is reachable
    try {
      const health = await fetch(`${harnessUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      const healthBody = await health.json().catch(() => null);
      if (!health.ok) {
        const configErrors = Array.isArray(healthBody?.config?.errors) ? `: ${healthBody.config.errors.join('; ')}` : '';
        throw new Error(`health returned ${health.status}${configErrors}`);
      }
      console.log('Harness reachable at', harnessUrl);
      const harnessProvider = healthBody?.modelProvider;
      if (harnessProvider?.name) {
        console.log(
          `Harness provider: ${harnessProvider.name} (${harnessProvider.configured ? 'configured' : 'not configured'})`
        );
        if (harnessProvider.name !== providerResolution.provider) {
          console.warn(
            `WARNING: eval resolved ${providerResolution.provider}, but the running harness reports ${harnessProvider.name}. Check NEWSROOM_MODEL_PROVIDER and env files.`
          );
        }
      }
    } catch (err) {
      console.error(`Cannot reach harness at ${harnessUrl}: ${err.message}`);
      console.error('Start the harness first (pnpm dev:harness) or use NEWSROOM_EVAL_MODE=fixture');
      process.exitCode = 1;
      return;
    }
  }

  const results = [];

  for (const promptEntry of filtered) {
    console.log(`\n[${promptEntry.id}] ${promptEntry.description}`);
    const budget = BUDGETS[promptEntry.latency_class] ?? BUDGETS.research;

    let run;
    let runPlanner = null;
    let runRouter = null;

    try {
    if (mode === 'fixture') {
        run = fixtureRunResult(promptEntry);
    } else {
      run = await fullRunAgainstHarness(promptEntry, undefined);

      if (comparePlanner) {
        // Explicit overrides keep the planner-vs-router diagnostic separate
        // from the production-default run evaluated above.
        runPlanner = await fullRunAgainstHarness(promptEntry, true);
        runRouter = await fullRunAgainstHarness(promptEntry, false);
      }
    }
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    results.push({
      id: promptEntry.id,
      class: promptEntry.class,
      trust_trap: promptEntry.trust_trap === true,
      error: err.message,
      passed: false
    });
    continue;
  }

    const evaluation = evalResult(promptEntry, run, budget);
    results.push({
    id: promptEntry.id,
    class: promptEntry.class,
    trust_trap: promptEntry.trust_trap === true,
    passed: evaluation.passed,
    checks: evaluation.checks,
    citation_metrics: evaluation.citationMetrics,
    ttft_ms: run.ttft_ms,
    total_ms: run.total_ms,
    answer: run.answer,
    citation_count: effectiveCitationRecords(run).length,
    legacy_source_count: run.legacySourceCount ?? 0,
    plan: run.plan
  });

    const icon = evaluation.passed ? '✓' : '✗';
    console.log(`  ${icon} ttft=${run.ttft_ms}ms total=${run.total_ms}ms`);
    for (const check of evaluation.checks) {
      const checkIcon = check.pass ? '  ✓' : '  ✗';
      console.log(`    ${checkIcon} ${check.name}: ${check.detail}`);
    }

    if (comparePlanner && runPlanner && runRouter) {
      console.log('\n  Planner vs Router comparison:');
      console.log(`    Planner: ttft=${runPlanner.ttft_ms}ms total=${runPlanner.total_ms}ms plan_steps=${runPlanner.plan?.steps?.length ?? 0} citations=${runPlanner.citations?.length ?? 0}`);
      console.log(`    Router:  ttft=${runRouter.ttft_ms}ms total=${runRouter.total_ms}ms plan_steps=${runRouter.plan?.steps?.length ?? 0} citations=${runRouter.citations?.length ?? 0}`);
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.length - passCount;
  const failedIds = results.filter((r) => !r.passed).map((r) => r.id);
  const trustTrapResults = results.filter((result) => result.trust_trap);
  const failedTrustTrapIds = trustTrapResults.filter((result) => !result.passed).map((result) => result.id);
  const fullSuiteRun = !promptFilter && results.length === EXPECTED_PROMPT_COUNT;
  const requiredPassCount = fullSuiteRun
    ? mode === 'full'
      ? LIVE_MIN_PASS_COUNT
      : EXPECTED_PROMPT_COUNT
    : results.length;
  const scoreGatePassed = passCount >= requiredPassCount;
  const trustTrapGatePassed = failedTrustTrapIds.length === 0;
  const gatePassed = scoreGatePassed && trustTrapGatePassed;

  console.log('\n' + '─'.repeat(60));
  console.log(`Results: ${passCount}/${results.length} passed${failCount > 0 ? ` — FAILED: ${failedIds.join(', ')}` : ''}`);
  console.log(
    `Gate: ${gatePassed ? 'PASS' : 'FAIL'} — score ${passCount}/${results.length} (required ${requiredPassCount}); trust traps ${trustTrapResults.length - failedTrustTrapIds.length}/${trustTrapResults.length}`
  );
  if (failedTrustTrapIds.length > 0) console.log(`Failed trust traps: ${failedTrustTrapIds.join(', ')}`);

  // Latency percentiles (full mode only)
  if (mode === 'full') {
    const researchResults = results.filter((r) => r.total_ms !== undefined);
    if (researchResults.length > 0) {
      const sorted = [...researchResults].sort((a, b) => a.total_ms - b.total_ms);
      const p50 = sorted[Math.floor(sorted.length * 0.5)]?.total_ms;
      const p90 = sorted[Math.floor(sorted.length * 0.9)]?.total_ms;
      console.log(`Latency: p50=${p50}ms p90=${p90}ms (n=${sorted.length})`);
    }
  }

  // Write results to disk
  const outDir = path.join(root, '.tmp', 'eval');
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `eval-${mode}-${Date.now()}.json`);
  await writeFile(
    outPath,
    JSON.stringify(
      {
        mode,
        provider: providerResolution,
        harnessUrl,
    comparePlanner,
    promptFilter,
    gate: {
      passed: gatePassed,
      requiredPassCount,
      actualPassCount: passCount,
      trustTrapCount: trustTrapResults.length,
      failedTrustTrapIds
    },
    results
      },
      null,
      2
    )
  );
  console.log(`Results written to ${outPath}`);

  if (!gatePassed) {
    process.exitCode = 1;
  }
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = parseSseEvent(raw);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  const event = parseSseEvent(buffer);
  if (event) yield event;
}

function parseSseEvent(raw) {
  if (!raw.trim()) return null;
  let event = 'message';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
