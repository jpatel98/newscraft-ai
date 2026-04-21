"use server";

import { revalidatePath } from "next/cache";
import { addSource, removeSource } from "@/db/queries/sources";
import { requireTenantContext } from "@/lib/server/app-context";
import { tenantAgentPath, tenantChannelPath } from "@/lib/server/tenant-path";

export type SaveNewsSourceInput = {
  orgSlug: string;
  workspaceSlug: string;
  url: string;
  label: string;
  kind: "rss" | "html";
};

function normalizeSourceUrl(raw: string) {
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

export async function saveNewsSource(input: SaveNewsSourceInput) {
  const { workspace } = await requireTenantContext(
    input.orgSlug,
    input.workspaceSlug,
  );
  const normalized = normalizeSourceUrl(input.url.trim());
  if (!normalized) {
    throw new Error("Enter a valid source URL.");
  }

  await addSource({
    workspaceId: workspace.id,
    url: normalized.toString(),
    label: input.label.trim() || normalized.hostname.replace(/^www\./, ""),
    kind: input.kind,
  });

  const tenantPath = {
    orgSlug: input.orgSlug,
    workspaceSlug: input.workspaceSlug,
  };
  revalidatePath(tenantAgentPath(tenantPath, "news-monitor"));
  revalidatePath(tenantChannelPath(tenantPath, "digest"));
  return { ok: true as const };
}

export async function deleteNewsSource(input: {
  orgSlug: string;
  workspaceSlug: string;
  idOrUrl: string;
}) {
  const { workspace } = await requireTenantContext(
    input.orgSlug,
    input.workspaceSlug,
  );
  await removeSource(workspace.id, input.idOrUrl);
  const tenantPath = {
    orgSlug: input.orgSlug,
    workspaceSlug: input.workspaceSlug,
  };
  revalidatePath(tenantAgentPath(tenantPath, "news-monitor"));
  revalidatePath(tenantChannelPath(tenantPath, "digest"));
  return { ok: true as const };
}
