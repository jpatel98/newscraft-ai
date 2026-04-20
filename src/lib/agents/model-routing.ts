export type ModelTier = "strong" | "fast";

export function getModelForTier(tier: ModelTier) {
  if (tier === "strong") {
    return process.env.OPENAI_MODEL_STRONG ?? "gpt-5.4";
  }
  return process.env.OPENAI_MODEL_FAST ?? "gpt-5.4-mini";
}

export function resolveModelTierForIntent(intent: string) {
  if (
    intent === "expert" ||
    intent === "scan-site" ||
    intent === "scout"
  ) {
    return "strong" as const;
  }
  return "fast" as const;
}
