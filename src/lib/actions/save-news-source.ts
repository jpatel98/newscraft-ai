"use server";

import { revalidatePath } from "next/cache";
import { addSource, removeSource } from "@/db/queries/sources";
import { requireWorkspaceMembership } from "@/lib/server/app-context";

export type SaveNewsSourceInput = {
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
  const { workspace } = await requireWorkspaceMembership();
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

  revalidatePath("/agent/news-monitor");
  revalidatePath("/channel/news-digest");
  return { ok: true as const };
}

export async function deleteNewsSource(idOrUrl: string) {
  const { workspace } = await requireWorkspaceMembership();
  await removeSource(workspace.id, idOrUrl);
  revalidatePath("/agent/news-monitor");
  revalidatePath("/channel/news-digest");
  return { ok: true as const };
}
