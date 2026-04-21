import { Agent, run } from "@openai/agents";
import { z } from "zod";
import {
  expertiseFinderResultSchema,
  normalizeExpertiseFinderResult,
} from "@/lib/agents/expertise-finder";
import {
  storyScoutBriefSchema,
  normalizeStoryScoutBrief,
} from "@/lib/agents/story-scout";
import {
  dailyDigestSchema,
  normalizeDailyDigest,
} from "@/lib/agents/news-monitor";

const verifierSchema = z.object({
  score: z.number().min(0).max(1),
  criticalIssues: z.array(z.string().min(1)).max(8).default([]),
  notes: z.array(z.string().min(1)).max(8).default([]),
});

const MAX_VERIFIER_REPAIR_ISSUES = 5;

type ValidationResult =
  | { ok: true; normalized: unknown; issues: string[]; repaired: boolean }
  | { ok: false; issues: string[] };

function getSchemaAndNormalizer(agentId: string): {
  schema: z.ZodObject<z.ZodRawShape>;
  normalize: (value: unknown) => unknown;
} {
  switch (agentId) {
    case "expertise-finder":
      return {
        schema: expertiseFinderResultSchema,
        normalize: (value) =>
          normalizeExpertiseFinderResult(
            value as z.infer<typeof expertiseFinderResultSchema>,
          ),
      };
    case "story-scout":
      return {
        schema: storyScoutBriefSchema,
        normalize: (value) =>
          normalizeStoryScoutBrief(value as z.infer<typeof storyScoutBriefSchema>),
      };
    case "news-monitor":
      return {
        schema: dailyDigestSchema,
        normalize: (value) =>
          normalizeDailyDigest(value as z.infer<typeof dailyDigestSchema>),
      };
    default:
      return {
        schema: z.object({}),
        normalize: (value) => value,
      };
  }
}

function evidenceIssues(agentId: string, normalized: unknown): string[] {
  if (agentId === "expertise-finder") {
    const parsed = normalized as z.infer<typeof expertiseFinderResultSchema>;
    if (parsed.experts.length < 1 && !allowsEmptyExpertResult(parsed)) {
      return ["No-source-no-claim gate failed: no valid experts remained."];
    }
  }
  if (agentId === "story-scout") {
    const parsed = normalized as z.infer<typeof storyScoutBriefSchema>;
    const hasInsufficientEvidenceSummary = isLowEvidenceSummary(parsed.summary);
    const hasAdvisoryOrClaimExpansions =
      parsed.angles.length > 0 ||
      parsed.suggestedVoices.length > 0 ||
      parsed.interviewQuestions.length > 0 ||
      parsed.watchouts.length > 0 ||
      parsed.relatedCoverage.length > 0;
    const allowsSourcedGapResponse =
      hasInsufficientEvidenceSummary && !hasAdvisoryOrClaimExpansions;
    if (parsed.background.length < 1 && !allowsSourcedGapResponse) {
      return ["No-source-no-claim gate failed: no sourced background facts."];
    }
  }
  if (agentId === "news-monitor") {
    const parsed = normalized as z.infer<typeof dailyDigestSchema>;
    if (parsed.items.length < 1 && !allowsEmptyDigest(parsed)) {
      return ["No-source-no-claim gate failed: no valid digest items remained."];
    }
  }
  return [];
}

function allowsEmptyExpertResult(
  parsed: z.infer<typeof expertiseFinderResultSchema>,
) {
  const combined = [
    parsed.summary,
    ...parsed.nextMoves,
    ...parsed.watchouts,
  ]
    .join(" ")
    .toLowerCase();

  const emptyExpertSignals = [
    "no strong candidates",
    "no suitable experts",
    "no verified experts",
    "could not verify",
    "couldn't verify",
    "not enough public evidence",
    "not enough public contact",
    "no direct public contact",
    "widen the brief",
    "narrow the brief",
    "broaden the search",
    "search was too narrow",
    "evidence was weak",
  ];

  return emptyExpertSignals.some((signal) => combined.includes(signal));
}

function isLowEvidenceSummary(summary: string) {
  return /(?:insufficient|limited reporting|thin coverage|early reporting|still emerging|unable|could not|cannot|not enough|no access|no verifiable|few verifiable|not yet clear|unclear from available reporting)/i.test(
    summary,
  );
}

function allowsEmptyDigest(parsed: z.infer<typeof dailyDigestSchema>) {
  if (parsed.producerNotes.length < 1) return false;

  const combined = [
    parsed.headline,
    parsed.summary,
    ...parsed.producerNotes,
  ]
    .join(" ")
    .toLowerCase();

  const emptyDigestSignals = [
    "no monitored sources",
    "not monitoring any",
    "no sources configured",
    "setup is still needed",
    "no qualifying digest items",
    "did not confirm any digest items",
    "no confirmed item links",
    "no valid item",
    "no new items",
    "no major updates",
    "nothing qualified",
  ];

  return emptyDigestSignals.some((signal) => combined.includes(signal));
}

async function repairOnce(input: {
  agentId: string;
  schema: z.ZodObject<z.ZodRawShape>;
  payload: unknown;
  issues: string[];
  model: string;
}) {
  const repairAgent = new Agent({
    name: "Output Repair",
    model: input.model,
    instructions:
      "Repair this JSON so it strictly satisfies the target schema. Return valid structured JSON only, no markdown.",
    outputType: input.schema,
  });

  const prompt = [
    `Agent: ${input.agentId}`,
    `Validation issues: ${input.issues.join("; ")}`,
    "Original payload JSON:",
    JSON.stringify(input.payload),
  ].join("\n\n");

  const repaired = await run(repairAgent, prompt, { stream: false });
  return repaired.finalOutput ?? null;
}

export async function validateNormalizeAndRepair(input: {
  agentId: string;
  payload: unknown;
  repairModel: string;
}) : Promise<ValidationResult> {
  const { schema, normalize } = getSchemaAndNormalizer(input.agentId);
  const first = schema.safeParse(input.payload);
  if (first.success) {
    const normalized = normalize(first.data);
    const issues = evidenceIssues(input.agentId, normalized);
    if (issues.length > 0) {
      return { ok: false, issues };
    }
    return { ok: true, normalized, issues: [], repaired: false };
  }

  const firstIssues = first.error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);

  const repairedPayload = await repairOnce({
    agentId: input.agentId,
    schema,
    payload: input.payload,
    issues: firstIssues,
    model: input.repairModel,
  });
  if (!repairedPayload) {
    return { ok: false, issues: firstIssues };
  }

  const second = schema.safeParse(repairedPayload);
  if (!second.success) {
    const secondIssues = second.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
    return { ok: false, issues: secondIssues };
  }

  const normalized = normalize(second.data);
  const issues = evidenceIssues(input.agentId, normalized);
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, normalized, issues: firstIssues, repaired: true };
}

export async function verifyOutputQuality(input: {
  agentId: string;
  prompt: string;
  output: unknown;
  model: string;
}) {
  const verifierAgent = new Agent({
    name: "Output Verifier",
    model: input.model,
    instructions:
      "Score factual support and citation sufficiency for the provided structured output. Return critical issues only for unsupported or uncited claims.",
    outputType: verifierSchema,
  });

  const verifierPrompt = [
    `Agent: ${input.agentId}`,
    `Original producer prompt: ${input.prompt}`,
    "Structured output JSON:",
    JSON.stringify(input.output),
    "Rules:",
    "- Penalize unsupported factual claims.",
    "- Penalize missing/weak citation links.",
    "- Use criticalIssues only for must-block problems about factual support or citation integrity.",
    "- Do not mark formatting gaps, style issues, or count-mismatch/completeness requests as critical.",
  ].join("\n\n");

  const result = await run(verifierAgent, verifierPrompt, { stream: false });
  const parsed = verifierSchema.safeParse(result.finalOutput ?? null);
  if (!parsed.success) {
    return {
      score: 0,
      criticalIssues: ["Verifier failed to produce a valid score payload."],
      notes: [],
    };
  }

  const hardCriticalIssues = parsed.data.criticalIssues.filter((issue) =>
    shouldBlockForCriticalIssue(issue)
  );
  const downgradedIssues = parsed.data.criticalIssues.filter(
    (issue) => !shouldBlockForCriticalIssue(issue),
  );

  return {
    score: parsed.data.score,
    criticalIssues: hardCriticalIssues,
    notes: [...parsed.data.notes, ...downgradedIssues].slice(0, 8),
  };
}

export async function repairOutputForVerifierIssues(input: {
  agentId: string;
  payload: unknown;
  criticalIssues: string[];
  model: string;
}) {
  if (input.criticalIssues.length < 1) {
    return { ok: false as const, issues: ["No verifier issues to repair."] };
  }

  const { schema, normalize } = getSchemaAndNormalizer(input.agentId);
  const repairAgent = new Agent({
    name: "Verifier Issue Repair",
    model: input.model,
    instructions:
      "Repair this structured JSON by removing or narrowing unsupported claims based on the verifier issues. Keep only claims supported by the cited sources. Preserve schema shape and return valid structured JSON only.",
    outputType: schema,
  });

  const prompt = [
    `Agent: ${input.agentId}`,
    "Verifier critical issues:",
    JSON.stringify(input.criticalIssues.slice(0, MAX_VERIFIER_REPAIR_ISSUES)),
    "Structured output JSON to repair:",
    JSON.stringify(input.payload),
  ].join("\n\n");

  const repaired = await run(repairAgent, prompt, { stream: false });
  if (!repaired.finalOutput) {
    return {
      ok: false as const,
      issues: ["Verifier repair returned empty output."],
    };
  }

  const parsed = schema.safeParse(repaired.finalOutput);
  if (!parsed.success) {
    const parseIssues = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
    return { ok: false as const, issues: parseIssues };
  }

  const normalized = normalize(parsed.data);
  const evidence = evidenceIssues(input.agentId, normalized);
  if (evidence.length > 0) {
    return { ok: false as const, issues: evidence };
  }

  return { ok: true as const, output: normalized };
}

export function getVerifierMinScore() {
  const raw = process.env.VERIFIER_MIN_SCORE;
  if (!raw) return 0.7;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0.7;
  return Math.min(1, Math.max(0, parsed));
}

function shouldBlockForCriticalIssue(issue: string) {
  const text = issue.toLowerCase();
  if (!text) return false;

  const hardSignals = [
    "unsupported",
    "not supported",
    "no source",
    "uncited",
    "missing citation",
    "citation",
    "fabricated",
    "hallucinat",
    "made up",
    "false claim",
    "inaccurate",
    "contradict",
  ];
  return hardSignals.some((signal) => text.includes(signal));
}
