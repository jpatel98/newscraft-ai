import { redirect } from "next/navigation";
import { resolveDefaultTenantRoute } from "@/lib/server/app-context";

export default async function Home() {
  const next = await resolveDefaultTenantRoute();
  if (!next) {
    return null;
  }
  redirect(next);
}
