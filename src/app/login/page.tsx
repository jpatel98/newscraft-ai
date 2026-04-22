import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/server/auth";
import { getDefaultTenantRouteForUser } from "@/lib/server/app-context";
import { safeRedirectTarget } from "@/lib/server/auth-redirect";
import {
  getGoogleClientId,
  getGoogleClientSecret,
} from "@/lib/server/auth-identities";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const safeNext = safeRedirectTarget(next);
  const userId = await getSessionUserId();
  if (userId) {
    const nextTenant = await getDefaultTenantRouteForUser(userId);
    if (nextTenant) {
      redirect(safeNext === "/" ? nextTenant.href : safeNext);
    }
  }

  const googleSigninHref = `/auth/google?next=${encodeURIComponent(safeNext)}`;
  const legacySigninHref = `/auth/general?next=${encodeURIComponent(safeNext)}`;
  const hasGoogleClient =
    Boolean(getGoogleClientId()) && Boolean(getGoogleClientSecret());

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-8">
      <section className="w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-md)]">
        <h1 className="text-xl font-semibold text-[var(--fg)]">Sign in</h1>
        <p className="mt-2 text-sm text-[var(--fg-muted)]">
          Continue to the workspace.
        </p>
        {error ? (
          <p className="mt-3 rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </p>
        ) : null}

        {hasGoogleClient ? (
          <Link
            href={googleSigninHref}
            className="mt-5 inline-flex w-full items-center justify-center rounded-[var(--radius-sm)] bg-[var(--fg)] px-4 py-2 text-sm font-medium text-white"
          >
            Continue with Google
          </Link>
        ) : null}

        <Link
          href={legacySigninHref}
          className={`mt-3 inline-flex w-full items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--fg)] ${
            hasGoogleClient ? "bg-transparent" : "bg-[var(--bg)]"
          }`}
        >
          Continue as local/general user
        </Link>
        {!hasGoogleClient ? (
          <>
            <p className="mt-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2 text-xs text-[var(--fg-subtle)]">
              Google sign-in is not configured. Configure GOOGLE_CLIENT_ID and
              GOOGLE_CLIENT_SECRET, or use the legacy sign-in path.
            </p>
          </>
        ) : null}
      </section>
    </main>
  );
}
