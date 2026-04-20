import { nanoid } from "nanoid";
import { z } from "zod";
import { insertAgentOutputAudit } from "@/db/queries/agent-output-audits";
import { loadAgentRuntimeConfig } from "@/db/queries/agents";
import { finishAgentRun, startAgentRun } from "@/db/queries/agent-runs";
import { getChannelById } from "@/db/queries/channels";
import { deleteMessagesByChannel, insertMessage } from "@/db/queries/messages";
import {
  clearThreadConversation,
  ensureThreadForChannel,
  updateThreadLastResponse,
} from "@/db/queries/threads";
import {
  getVerifierMinScore,
  repairOutputForVerifierIssues,
  validateNormalizeAndRepair,
  verifyOutputQuality,
} from "@/lib/agents/output-quality";
import { assertManualAgentRunAllowed } from "@/lib/agents/policy";
import { buildAgentRuntime } from "@/lib/agents/runtime";
import { getAgentStrict } from "@/lib/agents/catalog";
import { getModelForTier, resolveModelTierForIntent } from "@/lib/agents/model-routing";
import { HELP_REPLY, parseProducerInput } from "@/lib/commands";
import {
  isAppAuthError,
  requireTenantContext,
} from "@/lib/server/app-context";
import { runAgentWithStream } from "@/lib/stream/run-agent-stream";
import { encodeSSE } from "@/lib/stream/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  channelId: z.string().min(1),
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  message: z.string().trim().min(1),
});

const sseHeaders = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

function getPublicAgentErrorMessage(agentName: string) {
  return `${agentName} hit an internal error and could not finish this run. Try again in a moment.`;
}

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { ok: false, error: "Missing OPENAI_API_KEY." },
      { status: 500 },
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return Response.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 },
    );
  }

  const channel = await getChannelById(body.channelId);
  if (!channel) {
    return Response.json(
      { ok: false, error: "Channel not found." },
      { status: 404 },
    );
  }

  let context: Awaited<ReturnType<typeof requireTenantContext>>;
  try {
    context = await requireTenantContext(body.orgSlug, body.workspaceSlug);
  } catch (error) {
    if (isAppAuthError(error)) {
      return Response.json({ ok: false, error: error.message }, { status: 401 });
    }
    throw error;
  }

  if (context.workspace.id !== channel.workspaceId) {
    return Response.json(
      { ok: false, error: "You do not have access to this workspace." },
      { status: 403 },
    );
  }

  const parsed = parseProducerInput(body.message);
  if (parsed.kind === "error") {
    return Response.json(
      { ok: false, error: parsed.message },
      { status: 400 },
    );
  }

  const thread = await ensureThreadForChannel(channel.id);

  if (parsed.kind === "clear") {
    await deleteMessagesByChannel(channel.id);
    await clearThreadConversation(thread.id);
    return Response.json({ ok: true, cleared: true });
  }

  await insertMessage({
    threadId: thread.id,
    channelId: channel.id,
    role: "user",
    agentId: null,
    content: body.message,
  });

  if (parsed.kind === "help") {
    const assistantId = nanoid();
    await insertMessage({
      id: assistantId,
      threadId: thread.id,
      channelId: channel.id,
      role: "assistant",
      agentId: null,
      content: HELP_REPLY,
      renderer: "markdown",
    });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encodeSSE({ type: "token", delta: HELP_REPLY }));
          controller.enqueue(
            encodeSSE({ type: "final", payload: null, renderer: "markdown" }),
          );
          controller.enqueue(
            encodeSSE({ type: "done", messageId: assistantId, agentId: null }),
          );
          controller.close();
        },
      }),
      { headers: sseHeaders },
    );
  }

  const descriptor = getAgentStrict(parsed.agentId);
  const modelTier = resolveModelTierForIntent(parsed.intent);
  const modelDefault = getModelForTier(modelTier);
  const verifierModel = process.env.VERIFIER_MODEL ?? getModelForTier("strong");
  const config = await loadAgentRuntimeConfig(
    channel.workspaceId,
    context.organization.id,
    descriptor.id,
    modelDefault,
  );
  assertManualAgentRunAllowed(config, descriptor.defaultName);
  const agent = await buildAgentRuntime(descriptor.id, {
    workspaceId: channel.workspaceId,
    siteScope: parsed.siteScope,
    config,
  });

  const runRecord = await startAgentRun({
    threadId: thread.id,
    agentId: descriptor.id,
    inputSummary: parsed.cleanedPrompt,
  });

  const shouldContinueConversation = parsed.intent === "freeform";
  const previousResponseId = shouldContinueConversation
    ? thread.lastResponseId
    : null;

  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => abortController.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const assistantId = nanoid();
      const startedAt = Date.now();
      try {
        const result = await runAgentWithStream({
          agent,
          prompt: parsed.cleanedPrompt,
          previousResponseId,
          signal: abortController.signal,
          emit: (event) => controller.enqueue(encodeSSE(event)),
        });

        const validated = await validateNormalizeAndRepair({
          agentId: descriptor.id,
          payload: result.finalOutput ?? null,
          repairModel: getModelForTier("strong"),
        });
        if (!validated.ok) {
          throw new Error(
            `Structured output validation failed: ${validated.issues.join("; ")}`,
          );
        }

        let finalPayload = validated.normalized;
        let verifierRepaired = false;
        let verification = await verifyOutputQuality({
          agentId: descriptor.id,
          prompt: parsed.cleanedPrompt,
          output: finalPayload,
          model: verifierModel,
        });

        if (verification.criticalIssues.length > 0) {
          const verifierRepair = await repairOutputForVerifierIssues({
            agentId: descriptor.id,
            payload: finalPayload,
            criticalIssues: verification.criticalIssues,
            model: getModelForTier("strong"),
          });
          if (verifierRepair.ok) {
            finalPayload = verifierRepair.output;
            verifierRepaired = true;
            verification = await verifyOutputQuality({
              agentId: descriptor.id,
              prompt: parsed.cleanedPrompt,
              output: finalPayload,
              model: verifierModel,
            });
          }
        }

        const minScore = getVerifierMinScore();
        if (
          verification.score < minScore ||
          verification.criticalIssues.length > 0
        ) {
          throw new Error(
            `Verifier blocked output: score=${verification.score.toFixed(2)} issues=${verification.criticalIssues.join(", ")}`,
          );
        }

        controller.enqueue(
          encodeSSE({
            type: "final",
            payload: finalPayload,
            renderer: descriptor.renderer,
          }),
        );

        await insertMessage({
          id: assistantId,
          threadId: thread.id,
          channelId: channel.id,
          role: "assistant",
          agentId: descriptor.id,
          content: summarizeFinalContent(
            finalPayload,
            result.accumulatedText,
          ),
          payload: finalPayload,
          renderer: descriptor.renderer,
          runId: runRecord.id,
        });
        await updateThreadLastResponse(thread.id, result.lastResponseId);
        await finishAgentRun(runRecord.id, {
          status: "succeeded",
          lastResponseId: result.lastResponseId,
          error: null,
        });
        await insertAgentOutputAudit({
          runId: runRecord.id,
          agentId: descriptor.id,
          validationStatus:
            validated.repaired || verifierRepaired ? "repaired" : "passed",
          verifierScore: verification.score,
          issues: verification.notes,
          latencyMs: Date.now() - startedAt,
          toolFailureCount: result.toolFailureCount,
        });

        controller.enqueue(
          encodeSSE({
            type: "done",
            messageId: assistantId,
            agentId: descriptor.id,
          }),
        );
      } catch (error) {
        const internalMessage =
          error instanceof Error ? error.message : "Unknown agent error.";
        console.error("[api/chat] agent run failed", {
          agentId: descriptor.id,
          runId: runRecord.id,
          error: internalMessage,
        });
        controller.enqueue(
          encodeSSE({
            type: "error",
            message: getPublicAgentErrorMessage(descriptor.defaultName),
          }),
        );
        await finishAgentRun(runRecord.id, {
          status: abortController.signal.aborted ? "cancelled" : "failed",
          lastResponseId: null,
          error: internalMessage,
        });
        await insertAgentOutputAudit({
          runId: runRecord.id,
          agentId: descriptor.id,
          validationStatus: "failed",
          verifierScore: null,
          issues: [internalMessage],
          latencyMs: Date.now() - startedAt,
          toolFailureCount: 0,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders });
}

function summarizeFinalContent(payload: unknown, fallback: string): string {
  if (payload === null || payload === undefined) return fallback;
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.summary === "string") return obj.summary;
    if (typeof obj.headline === "string") return obj.headline;
  }
  return fallback || JSON.stringify(payload);
}
