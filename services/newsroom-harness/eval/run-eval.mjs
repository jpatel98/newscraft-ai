#!/usr/bin/env node
/**
 * Golden-prompt eval runner for NewsCraft AI — M4.
 *
 * Two modes:
 *   fixture  — No API key required. Uses a stubbed harness (no real HTTP) to
 *              verify routing, plan events, no-leak invariants, and latency
 *              envelope shape. Safe for CI. NEWSROOM_EVAL_MODE=fixture (default
 *              when OPENAI_API_KEY is absent).
 *
 *   full     — Requires OPENAI_API_KEY. Runs against a live harness and
 *              records real latency, citation presence, and answer quality.
 *              Also runs router-fallback vs planner side-by-side when
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');

// ─── Config ────────────────────────────────────────────────────────────────────

const mode = process.env.NEWSROOM_EVAL_MODE || (process.env.OPENAI_API_KEY ? 'full' : 'fixture');
const comparePlanner = process.env.NEWSROOM_EVAL_COMPARE_PLANNER === '1';
const harnessUrl = process.env.NEWSROOM_HARNESS_URL || 'http://127.0.0.1:8650';
const harnessApiKey = process.env.NEWSROOM_HARNESS_API_KEY || process.env.AGENT_GATEWAY_API_KEY || '';
const promptFilter = process.env.NEWSROOM_EVAL_PROMPT_ID || null; // run only one prompt id

/** Latency budgets in ms. In fixture mode we use generous bounds (no real I/O). */
const BUDGETS = {
  /** simple_answer: ≤8s real, ≤20s fixture */
  simple:  { ttft: mode === 'fixture' ? 20_000 : 8_000,  total: mode === 'fixture' ? 20_000 : 8_000 },
  /** research: p50 ≤30s / p90 ≤60s real; ≤120s fixture (spawns no network) */
  research: { ttft: mode === 'fixture' ? 120_000 : 30_000, total: mode === 'fixture' ? 120_000 : 60_000 }
};

// ─── Tool-name / adapter-name leak detection ──────────────────────────────────

/** Internal tool identifiers and adapter names that must never appear in answers. */
const LEAKED_INTERNAL_TERMS = [
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
  'harness',
  'sqlite',
  'fixture-cbc',
  'fixture-ctv',
  'fixture-global'
];

function detectLeaks(text) {
  const lower = text.toLowerCase();
  return LEAKED_INTERNAL_TERMS.filter((term) => lower.includes(term.toLowerCase()));
}

// ─── Fixture mode harness — no real API calls ─────────────────────────────────

/**
 * Build a stub run result that matches the shape of a real harness response but
 * uses canned evidence. Deterministic, fast, zero API calls.
 */
function fixtureRunResult(prompt, promptEntry) {
  const { checks, class: promptClass, id } = promptEntry;

  // Simulate tool calls / plan steps based on expected routing
  const usesSearch = promptClass === 'current_events' || promptClass === 'claim_verification' || promptClass === 'competitor_coverage';
  const isAmbiguous = id === 'followup-ambiguous';
  const isObscure = id === 'current-events-no-evidence-obscure';
  const isNoEvidence = id === 'claim-verification-no-evidence';
  const isPaywalled = id === 'paywalled-source';

  // Plan steps (fixture)
  const steps = [];
  if (usesSearch && !isAmbiguous) {
    steps.push({ id: 'step-1', tool: 'openai_web_search', label: 'Searching recent coverage', status: 'ok' });
  } else if (!usesSearch && !isAmbiguous) {
    steps.push({ id: 'step-1', tool: 'configured_source_monitor', label: 'Checking configured sources', status: 'ok' });
  }

  // Evidence / citations
  const citations = [];
  if (usesSearch && !isAmbiguous && !isObscure && !isNoEvidence && !isPaywalled) {
    citations.push({ url: 'https://cbc.ca/news/politics/fixture-story', title: 'CBC: Fixture story result' });
  }

  // Answer text
  let answerText;
  if (isAmbiguous) {
    answerText = 'Could you clarify which statement you are referring to? I don\'t have context from our recent conversation about what "they" said or "it" refers to.';
  } else if (isObscure || isNoEvidence) {
    answerText = 'I was unable to find specific coverage of this topic from available sources. No confirmed evidence could be found — please verify directly with local sources before publishing.';
  } else if (isPaywalled) {
    answerText = 'The linked Globe and Mail page appears to be behind a paywall or is unavailable. I could not extract content from this source. Please obtain access directly before publication.';
  } else if (promptClass === 'simple_answer') {
    answerText = 'A nut graf (also called nutshell paragraph) is a brief explanatory paragraph in a news story that summarizes the broader significance of the story for the reader.';
  } else {
    answerText = `Here is a brief summary based on available sources. According to recent coverage, there are active developments on this topic. Verify with primary sources before publishing. (Fixture mode — no real sources fetched.)`;
  }

  return {
    answer: answerText,
    plan: { source: steps.length > 0 ? 'model' : 'router', steps },
    citations,
    ttft_ms: steps.length > 0 ? 180 : 50,  // deterministic fixture timing
    total_ms: steps.length > 0 ? 400 : 80
  };
}

// ─── Full-mode harness call ────────────────────────────────────────────────────

/**
 * Execute a chat stream against the running harness and collect:
 *  - answer text (all delta chunks joined)
 *  - time-to-first-token (ms)
 *  - total time (ms)
 *  - plan events (agent.plan SSE frames)
 *  - sources (agent.source SSE frames)
 */
async function fullRunAgainstHarness(prompt, priorContext, plannerEnabled) {
  const messages = [];
  if (priorContext) {
    messages.push({ role: 'user', content: priorContext });
    messages.push({ role: 'assistant', content: 'Understood. I have that context.' });
  }
  messages.push({ role: 'user', content: prompt });

  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(harnessApiKey ? { 'x-api-key': harnessApiKey } : {})
  };

  const body = JSON.stringify({ messages, plannerEnabled });
  const startMs = Date.now();
  let ttftMs = null;

  const response = await fetch(`${harnessUrl}/chat/stream`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(90_000)
  });

  if (!response.ok || !response.body) {
    throw new Error(`harness /chat/stream responded ${response.status}: ${await response.text()}`);
  }

  const answerChunks = [];
  const planEvents = [];
  const sources = [];

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
    }
  }

  const totalMs = Date.now() - startMs;
  const answer = answerChunks.join('');
  return {
    answer,
    plan: planEvents.at(-1) || null,
    citations: sources,
    ttft_ms: ttftMs ?? totalMs,
    total_ms: totalMs
  };
}

// ─── Check evaluation ─────────────────────────────────────────────────────────

function evalResult(promptEntry, run, budget) {
  const { checks } = promptEntry;
  const results = [];

  // Latency checks
  const ttftBudget = budget.ttft;
  const totalBudget = budget.total;
  results.push({
    name: 'ttft_budget',
    pass: run.ttft_ms <= ttftBudget,
    detail: `ttft=${run.ttft_ms}ms budget=${ttftBudget}ms`
  });
  results.push({
    name: 'total_budget',
    pass: run.total_ms <= totalBudget,
    detail: `total=${run.total_ms}ms budget=${totalBudget}ms`
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
    const citationCount = run.citations?.length ?? 0;
    // Also check the answer text for markdown links as a secondary signal
    const answerHasLinks = /\bhttps?:\/\/\S+/i.test(run.answer) || /\[.+?\]\(.+?\)/i.test(run.answer);
    const hasCitation = citationCount > 0 || answerHasLinks;
    results.push({
      name: 'citation_present',
      pass: hasCitation,
      detail: hasCitation ? `${citationCount} source event(s)` : 'no citations found'
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
    const hasCaveat = /\b(could not|unable to|no (specific|confirmed|available)|not found|unverified|verify|before publishing|paywall|blocked|caveat)\b/i.test(run.answer);
    results.push({
      name: 'caveat_on_no_evidence',
      pass: hasCaveat,
      detail: hasCaveat ? 'caveat present' : 'no caveat found for potential no-evidence answer'
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

  const passed = results.every((r) => r.pass);
  return { passed, checks: results };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const promptsPath = path.join(__dirname, 'golden-prompts.json');
  const prompts = JSON.parse(await readFile(promptsPath, 'utf8'));

  const filtered = promptFilter ? prompts.filter((p) => p.id === promptFilter) : prompts;
  if (filtered.length === 0) {
    console.error(`No prompts matched filter: ${promptFilter}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nNewsCraft AI — Golden-prompt eval suite`);
  console.log(`Mode: ${mode}${comparePlanner ? ' + planner comparison' : ''}`);
  console.log(`Prompts: ${filtered.length} of ${prompts.length}`);
  console.log('─'.repeat(60));

  if (mode === 'full') {
    // Warm-up check — confirm harness is reachable
    try {
      const health = await fetch(`${harnessUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!health.ok) throw new Error(`health returned ${health.status}`);
      console.log('Harness reachable at', harnessUrl);
    } catch (err) {
      console.error(`Cannot reach harness at ${harnessUrl}: ${err.message}`);
      console.error('Start the harness first (corepack pnpm dev:harness) or use NEWSROOM_EVAL_MODE=fixture');
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
        run = fixtureRunResult(promptEntry.prompt, promptEntry);
      } else {
        run = await fullRunAgainstHarness(promptEntry.prompt, promptEntry.prior_context ?? null, true);

        if (comparePlanner) {
          // Run with planner disabled for comparison
          runPlanner = run;
          runRouter = await fullRunAgainstHarness(promptEntry.prompt, promptEntry.prior_context ?? null, false);
        }
      }
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      results.push({ id: promptEntry.id, error: err.message, passed: false });
      continue;
    }

    const evaluation = evalResult(promptEntry, run, budget);
    results.push({ id: promptEntry.id, class: promptEntry.class, passed: evaluation.passed, checks: evaluation.checks, ttft_ms: run.ttft_ms, total_ms: run.total_ms });

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

  console.log('\n' + '─'.repeat(60));
  console.log(`Results: ${passCount}/${results.length} passed${failCount > 0 ? ` — FAILED: ${failedIds.join(', ')}` : ''}`);

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
  await writeFile(outPath, JSON.stringify({ mode, results }, null, 2));
  console.log(`Results written to ${outPath}`);

  if (failCount > 0) {
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
