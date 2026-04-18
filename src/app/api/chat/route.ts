import { nanoid } from "nanoid";
import { z } from "zod";
import { getAgentStrict } from "@/lib/agents/registry";
import { HELP_REPLY, parseProducerInput } from "@/lib/commands";
import { encodeSSE } from "@/lib/stream/sse";
import { runAgentWithStream } from "@/lib/stream/run-agent-stream";
import { getChannelById } from "@/db/queries/channels";
import {
  ensureThreadForChannel,
  updateThreadLastResponse,
} from "@/db/queries/threads";
import { insertMessage } from "@/db/queries/messages";
import { finishAgentRun, startAgentRun } from "@/db/queries/agent-runs";

export const runtime = "nodejs";

const bodySchema = z.object({
  channelId: z.string().min(1),
  message: z.string().trim().min(1),
});

const sseHeaders = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

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

  const fallbackAgentId = channel.agentId ?? "expertise-finder";
  const parsed = parseProducerInput(body.message, fallbackAgentId);

  const thread = await ensureThreadForChannel(channel.id);

  await insertMessage({
    threadId: thread.id,
    channelId: channel.id,
    role: "user",
    agentId: channel.agentId,
    content: body.message,
  });

  if (parsed.kind === "help") {
    const assistantId = nanoid();
    await insertMessage({
      id: assistantId,
      threadId: thread.id,
      channelId: channel.id,
      role: "assistant",
      agentId: channel.agentId,
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
            encodeSSE({ type: "done", messageId: assistantId }),
          );
          controller.close();
        },
      }),
      { headers: sseHeaders },
    );
  }

  if (parsed.kind === "error") {
    return Response.json(
      { ok: false, error: parsed.message },
      { status: 400 },
    );
  }

  const descriptor = getAgentStrict(parsed.agentId);
  const agent = descriptor.build({
    workspaceId: channel.workspaceId,
    siteScope: parsed.siteScope,
  });

  const runRecord = await startAgentRun({
    threadId: thread.id,
    agentId: descriptor.id,
    inputSummary: parsed.cleanedPrompt,
  });

  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => abortController.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const assistantId = nanoid();
      try {
        const result = await runAgentWithStream({
          agent,
          prompt: parsed.cleanedPrompt,
          previousResponseId: thread.lastResponseId,
          signal: abortController.signal,
          emit: (event) => controller.enqueue(encodeSSE(event)),
        });

        controller.enqueue(
          encodeSSE({
            type: "final",
            payload: result.finalOutput ?? null,
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
            result.finalOutput,
            result.accumulatedText,
          ),
          payload: result.finalOutput ?? null,
          renderer: descriptor.renderer,
          runId: runRecord.id,
        });
        await updateThreadLastResponse(thread.id, result.lastResponseId);
        await finishAgentRun(runRecord.id, {
          status: "succeeded",
          lastResponseId: result.lastResponseId,
          error: null,
        });

        controller.enqueue(
          encodeSSE({ type: "done", messageId: assistantId }),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown agent error.";
        controller.enqueue(encodeSSE({ type: "error", message }));
        await finishAgentRun(runRecord.id, {
          status: "failed",
          lastResponseId: null,
          error: message,
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
