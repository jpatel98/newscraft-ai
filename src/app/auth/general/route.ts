import { redirect } from "next/navigation";
import { getUserByEmail } from "@/db/queries/access";
import { createSessionForUser } from "@/lib/server/auth";
import { getDefaultTenantRouteForUser } from "@/lib/server/app-context";
import { safeRedirectTarget } from "@/lib/server/auth-redirect";
import { getGeneralEmail } from "@/lib/server/auth-identities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeRedirectTarget(url.searchParams.get("next"));
  const user = await getUserByEmail(getGeneralEmail());
  if (!user) {
    return Response.json(
      {
        ok: false,
        error:
          "General user is not seeded. Run `npm run db:migrate` and `npm run db:seed`.",
      },
      { status: 500 },
    );
  }

  await createSessionForUser(user.id);
  if (next === "/") {
    const tenantRoute = await getDefaultTenantRouteForUser(user.id);
    redirect(tenantRoute?.href ?? "/");
  }
  redirect(next);
}
