import { nanoid } from "nanoid";
import { assertScheduledAgentRunAllowed } from "@/lib/agents/policy";
import { getAgentStrict } from "@/lib/agents/catalog";
import { buildAgentRuntime } from "@/lib/agents/runtime";
import { loadAgentRuntimeConfig } from "@/db/queries/agents";
import { getChannelBySlug } from "@/db/queries/channels";
import {
  ensureThreadForChannel,
  updateThreadLastResponse,
} from "@/db/queries/threads";
import { insertMessage } from "@/db/queries/messages";
import { insertDigest } from "@/db/queries/digests";
import { finishAgentRun, startAgentRun } from "@/db/queries/agent-runs";
import { emptySiteScope } from "@/lib/site-scope";
import { runAgentWithStream } from "@/lib/stream/run-agent-stream";
import type { DailyDigest } from "@/lib/agents/news-monitor";
import { DEFAULT_WORKSPACE_ID } from "@/lib/server/app-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIGEST_CHANNEL_SLUG = "news-digest";

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return Response.json(
      { ok: false, error: "Unauthorized." },
      { status: 401 },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { ok: false, error: "Missing OPENAI_API_KEY." },
      { status: 500 },
    );
  }

  const channel = await getChannelBySlug(DEFAULT_WORKSPACE_ID, DIGEST_CHANNEL_SLUG);
  if (!channel) {
    return Response.json(
      { ok: false, error: `Channel #${DIGEST_CHANNEL_SLUG} not found.` },
      { status: 404 },
    );
  }

  const descriptor = getAgentStrict("news-monitor");
  const config = await loadAgentRuntimeConfig(DEFAULT_WORKSPACE_ID, descriptor.id);
  assertScheduledAgentRunAllowed(config, descriptor.defaultName);
  const agent = await buildAgentRuntime(descriptor.id, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    siteScope: emptySiteScope(),
    config,
  });

  const thread = await ensureThreadForChannel(channel.id);
  const runRecord = await startAgentRun({
    threadId: thread.id,
    agentId: descriptor.id,
    inputSummary: "scheduled digest",
  });

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Generate today's newsroom digest. Today is ${today}. Call list_sources first. Prioritize the past 24 hours.`;

  try {
    const result = await runAgentWithStream({
      agent,
      prompt,
      previousResponseId: null,
      emit: () => {
        // No client to receive events for scheduled runs.
      },
    });

    const digest = (result.finalOutput ?? null) as DailyDigest | null;
    if (!digest) {
      throw new Error("News Monitor did not return a digest.");
    }

    const messageId = nanoid();
    await insertMessage({
      id: messageId,
      threadId: thread.id,
      channelId: channel.id,
      role: "assistant",
      agentId: descriptor.id,
      content: digest.headline,
      payload: digest,
      renderer: "digest",
      runId: runRecord.id,
    });
    await insertDigest({
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: channel.id,
      messageId,
      dateKey: digest.dateKey || today,
      items: digest.items,
    });
    await finishAgentRun(runRecord.id, {
      status: "succeeded",
      lastResponseId: result.lastResponseId,
      error: null,
    });
    await updateThreadLastResponse(thread.id, result.lastResponseId);

    return Response.json({
      ok: true,
      digestId: messageId,
      dateKey: digest.dateKey || today,
      itemCount: digest.items.length,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown digest error.";
    await finishAgentRun(runRecord.id, {
      status: "failed",
      lastResponseId: null,
      error: message,
    });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
