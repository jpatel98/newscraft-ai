import { redirect } from "next/navigation";
import { resolveDefaultTenantRoute } from "@/lib/server/app-context";

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const next = await resolveDefaultTenantRoute();
  if (!next) return null;
  redirect(`${next}/channel/${slug}`);
}
