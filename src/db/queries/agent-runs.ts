import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import { agentRuns, type AgentRunRow } from "@/db/schema";

export async function startAgentRun(input: {
  threadId: string;
  agentId: string;
  inputSummary: string;
}): Promise<AgentRunRow> {
  const row: AgentRunRow = {
    id: nanoid(),
    threadId: input.threadId,
    agentId: input.agentId,
    runId: null,
    lastResponseId: null,
    status: "running",
    inputSummary: input.inputSummary.slice(0, 500),
    error: null,
    createdAt: Date.now(),
    endedAt: null,
  };
  await db.insert(agentRuns).values(row);
  return row;
}

export async function finishAgentRun(
  id: string,
  patch: Pick<AgentRunRow, "status" | "lastResponseId" | "error">,
) {
  await db
    .update(agentRuns)
    .set({ ...patch, endedAt: Date.now() })
    .where(eq(agentRuns.id, id));
}
