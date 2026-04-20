import { notFound, redirect } from "next/navigation";
import { getUserByEmail } from "@/db/queries/access";
import { createSessionForUser } from "@/lib/server/auth";
import { getDefaultTenantRouteForUser } from "@/lib/server/app-context";
import { safeRedirectTarget } from "@/lib/server/auth-redirect";
import {
  getAdminEmail,
  getAdminSigninToken,
} from "@/lib/server/auth-identities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/auth/special/[token]">,
) {
  const { token } = await context.params;
  if (token !== getAdminSigninToken()) {
    notFound();
  }

  const adminUser = await getUserByEmail(getAdminEmail());
  if (!adminUser) {
    return Response.json(
      {
        ok: false,
        error:
          "Admin user is not seeded. Run `npm run db:migrate` and `npm run db:seed`.",
      },
      { status: 500 },
    );
  }

  await createSessionForUser(adminUser.id);
  const url = new URL(request.url);
  const next = safeRedirectTarget(url.searchParams.get("next"));
  if (next === "/") {
    const tenantRoute = await getDefaultTenantRouteForUser(adminUser.id);
    redirect(tenantRoute?.href ?? "/");
  }
  redirect(next);
}
