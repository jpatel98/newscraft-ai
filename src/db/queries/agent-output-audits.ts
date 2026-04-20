import { nanoid } from "nanoid";
import { db } from "@/db/client";
import { agentOutputAudits } from "@/db/schema";

export async function insertAgentOutputAudit(input: {
  runId: string;
  agentId: string;
  validationStatus: "passed" | "repaired" | "failed";
  verifierScore: number | null;
  issues: string[];
  latencyMs: number;
  toolFailureCount: number;
}) {
  await db.insert(agentOutputAudits).values({
    id: nanoid(),
    runId: input.runId,
    agentId: input.agentId,
    validationStatus: input.validationStatus,
    verifierScore: input.verifierScore,
    issues: input.issues,
    latencyMs: input.latencyMs,
    toolFailureCount: input.toolFailureCount,
    createdAt: Date.now(),
  });
}
