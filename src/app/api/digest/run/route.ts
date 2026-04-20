import { nanoid } from "nanoid";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { insertAgentOutputAudit } from "@/db/queries/agent-output-audits";
import { loadAgentRuntimeConfig } from "@/db/queries/agents";
import { finishAgentRun, startAgentRun } from "@/db/queries/agent-runs";
import { getChannelBySlug } from "@/db/queries/channels";
import { insertDigest } from "@/db/queries/digests";
import { insertMessage } from "@/db/queries/messages";
import { listSources } from "@/db/queries/sources";
import {
  ensureThreadForChannel,
  updateThreadLastResponse,
} from "@/db/queries/threads";
import { organizations, workspaces } from "@/db/schema";
import {
  getVerifierMinScore,
  repairOutputForVerifierIssues,
  validateNormalizeAndRepair,
  verifyOutputQuality,
} from "@/lib/agents/output-quality";
import { assertScheduledAgentRunAllowed } from "@/lib/agents/policy";
import { buildAgentRuntime } from "@/lib/agents/runtime";
import { getAgentStrict } from "@/lib/agents/catalog";
import { createEmptyDailyDigest } from "@/lib/agents/news-monitor";
import { getModelForTier } from "@/lib/agents/model-routing";
import { emptySiteScope } from "@/lib/site-scope";
import { runAgentWithStream } from "@/lib/stream/run-agent-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIGEST_CHANNEL_SLUG = "news-digest";

const bodySchema = z
  .object({
    orgSlug: z.string().min(1).optional(),
    workspaceSlug: z.string().min(1).optional(),
  })
  .optional();

type WorkspaceTarget = {
  organizationId: string;
  organizationSlug: string;
  workspaceId: string;
  workspaceSlug: string;
};

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

  let body: z.infer<typeof bodySchema> = undefined;
  try {
    const raw = await request.json().catch(() => null);
    body = bodySchema.parse(raw ?? undefined);
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const targets = await resolveTargets(body);
  if (targets.length === 0) {
    return Response.json({ ok: false, error: "No target workspace found." }, { status: 404 });
  }

  const results = [];
  for (const target of targets) {
    results.push(await runDigestForWorkspace(target));
  }

  return Response.json({ ok: true, results });
}

async function resolveTargets(
  body: z.infer<typeof bodySchema>,
): Promise<WorkspaceTarget[]> {
  if (body?.orgSlug && body.workspaceSlug) {
    const rows = await db
      .select({
        organizationId: organizations.id,
        organizationSlug: organizations.slug,
        workspaceId: workspaces.id,
        workspaceSlug: workspaces.slug,
      })
      .from(workspaces)
      .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
      .where(
        and(
          eq(organizations.slug, body.orgSlug),
          eq(workspaces.slug, body.workspaceSlug),
        ),
      )
      .limit(1);
    return rows;
  }

  return db
    .select({
      organizationId: organizations.id,
      organizationSlug: organizations.slug,
      workspaceId: workspaces.id,
      workspaceSlug: workspaces.slug,
    })
    .from(workspaces)
    .innerJoin(organizations, eq(organizations.id, workspaces.organizationId));
}

async function runDigestForWorkspace(target: WorkspaceTarget) {
  const channel = await getChannelBySlug(target.workspaceId, DIGEST_CHANNEL_SLUG);
  if (!channel) {
    return {
      ok: false,
      workspaceId: target.workspaceId,
      workspaceSlug: target.workspaceSlug,
      error: `Channel #${DIGEST_CHANNEL_SLUG} not found.`,
    };
  }

  const descriptor = getAgentStrict("news-monitor");
  const config = await loadAgentRuntimeConfig(
    target.workspaceId,
    target.organizationId,
    descriptor.id,
    getModelForTier("fast"),
  );
  assertScheduledAgentRunAllowed(config, descriptor.defaultName);
  const thread = await ensureThreadForChannel(channel.id);
  const runRecord = await startAgentRun({
    threadId: thread.id,
    agentId: descriptor.id,
    inputSummary: "scheduled digest",
  });
  const sources = await listSources(target.workspaceId);
  if (sources.length < 1) {
    await finishAgentRun(runRecord.id, {
      status: "succeeded",
      lastResponseId: null,
      error: null,
    });
    await insertAgentOutputAudit({
      runId: runRecord.id,
      agentId: descriptor.id,
      validationStatus: "passed",
      verifierScore: 1,
      issues: ["Skipped scheduled digest because no sources are configured."],
      latencyMs: 0,
      toolFailureCount: 0,
    });
    return {
      ok: true,
      workspaceId: target.workspaceId,
      workspaceSlug: target.workspaceSlug,
      itemCount: 0,
      skipped: "no-sources-configured",
      digest: createEmptyDailyDigest({ mode: "no-sources" }),
    };
  }

  const agent = await buildAgentRuntime(descriptor.id, {
    workspaceId: target.workspaceId,
    siteScope: emptySiteScope(),
    config,
  });

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Generate today's newsroom digest. Today is ${today}. Call list_sources first. Prioritize the past 24 hours.`;
  const startedAt = Date.now();

  try {
    const result = await runAgentWithStream({
      agent,
      prompt,
      previousResponseId: null,
      emit: () => {},
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
      prompt,
      output: finalPayload,
      model: process.env.VERIFIER_MODEL ?? getModelForTier("strong"),
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
          prompt,
          output: finalPayload,
          model: process.env.VERIFIER_MODEL ?? getModelForTier("strong"),
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

    const digest = finalPayload as {
      dateKey: string;
      headline: string;
      items: unknown[];
    };

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
      workspaceId: target.workspaceId,
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

    return {
      ok: true,
      workspaceId: target.workspaceId,
      workspaceSlug: target.workspaceSlug,
      digestId: messageId,
      dateKey: digest.dateKey || today,
      itemCount: digest.items.length,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown digest error.";
    await finishAgentRun(runRecord.id, {
      status: "failed",
      lastResponseId: null,
      error: message,
    });
    await insertAgentOutputAudit({
      runId: runRecord.id,
      agentId: descriptor.id,
      validationStatus: "failed",
      verifierScore: null,
      issues: [message],
      latencyMs: Date.now() - startedAt,
      toolFailureCount: 0,
    });
    return {
      ok: false,
      workspaceId: target.workspaceId,
      workspaceSlug: target.workspaceSlug,
      error: message,
    };
  }
}
