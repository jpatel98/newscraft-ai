import { redirect } from "next/navigation";
import { resolveDefaultTenantRoute } from "@/lib/server/app-context";

export default async function AgentConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const next = await resolveDefaultTenantRoute();
  if (!next) return null;
  redirect(`${next}/agent/${id}`);
}
