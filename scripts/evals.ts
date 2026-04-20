import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getModelForTier } from "@/lib/agents/model-routing";
import {
  getVerifierMinScore,
  validateNormalizeAndRepair,
  verifyOutputQuality,
} from "@/lib/agents/output-quality";

type EvalRow = {
  id: string;
  agentId: "expertise-finder" | "story-scout" | "news-monitor";
  prompt: string;
  sampleOutput: unknown;
};

type Metrics = {
  total: number;
  schemaPass: number;
  citationPass: number;
  verifierPass: number;
  latencyMsTotal: number;
  toolFailureRate: number;
};

function readJsonl(path: string): EvalRow[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalRow);
}

function isCitationComplete(agentId: EvalRow["agentId"], payload: unknown) {
  if (agentId === "expertise-finder") {
    const experts = (payload as { experts?: Array<{ source?: { url?: string } }> })
      .experts;
    return Array.isArray(experts) && experts.every((e) => !!e.source?.url);
  }
  if (agentId === "story-scout") {
    const bg = (payload as { background?: Array<{ source?: { url?: string } }> })
      .background;
    return Array.isArray(bg) && bg.length > 0 && bg.every((f) => !!f.source?.url);
  }
  const items = (payload as { items?: Array<{ sourceUrl?: string }> }).items;
  return Array.isArray(items) && items.length > 0 && items.every((i) => !!i.sourceUrl);
}

async function runOne(row: EvalRow, liveVerifier: boolean) {
  const started = Date.now();
  const validation = await validateNormalizeAndRepair({
    agentId: row.agentId,
    payload: row.sampleOutput,
    repairModel: getModelForTier("strong"),
  });
  const latencyMs = Date.now() - started;
  if (!validation.ok) {
    return {
      schemaPass: false,
      citationPass: false,
      verifierPass: false,
      latencyMs,
    };
  }

  const citationPass = isCitationComplete(row.agentId, validation.normalized);
  let verifierPass = true;
  if (liveVerifier && process.env.OPENAI_API_KEY) {
    const verification = await verifyOutputQuality({
      agentId: row.agentId,
      prompt: row.prompt,
      output: validation.normalized,
      model: process.env.VERIFIER_MODEL ?? getModelForTier("strong"),
    });
    verifierPass =
      verification.score >= getVerifierMinScore() &&
      verification.criticalIssues.length === 0;
  }

  return {
    schemaPass: true,
    citationPass,
    verifierPass,
    latencyMs,
  };
}

async function main() {
  const files = [
    join(process.cwd(), "evals", "expertise.jsonl"),
    join(process.cwd(), "evals", "scout.jsonl"),
    join(process.cwd(), "evals", "digest.jsonl"),
  ];
  const rows = files.flatMap((file) => readJsonl(file));
  const liveVerifier = process.env.EVALS_LIVE_VERIFY === "1";

  const metrics: Metrics = {
    total: rows.length,
    schemaPass: 0,
    citationPass: 0,
    verifierPass: 0,
    latencyMsTotal: 0,
    toolFailureRate: 0,
  };

  for (const row of rows) {
    const result = await runOne(row, liveVerifier);
    if (result.schemaPass) metrics.schemaPass += 1;
    if (result.citationPass) metrics.citationPass += 1;
    if (result.verifierPass) metrics.verifierPass += 1;
    metrics.latencyMsTotal += result.latencyMs;
  }

  const schemaPassRate = metrics.schemaPass / metrics.total;
  const citationCompleteness = metrics.citationPass / metrics.total;
  const verifierPassRate = metrics.verifierPass / metrics.total;
  const avgLatencyMs = metrics.latencyMsTotal / metrics.total;

  console.log("Eval metrics");
  console.log(
    JSON.stringify(
      {
        total: metrics.total,
        schemaPassRate,
        citationCompleteness,
        verifierPassRate,
        avgLatencyMs,
        toolFailureRate: metrics.toolFailureRate,
      },
      null,
      2,
    ),
  );

  const baselinePath = join(process.cwd(), "evals", "baseline.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
    schemaPassRate: number;
    verifierPassRate: number;
  };

  const allowedRegression = Number(process.env.EVAL_MAX_REGRESSION ?? "0.03");
  const schemaRegressed =
    schemaPassRate < baseline.schemaPassRate - allowedRegression;
  const verifierRegressed =
    verifierPassRate < baseline.verifierPassRate - allowedRegression;
  const hardFail =
    schemaPassRate < 0.9 || verifierPassRate < 0.85 || citationCompleteness < 0.9;

  if (schemaRegressed || verifierRegressed || hardFail) {
    console.error("Eval quality gate failed.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
